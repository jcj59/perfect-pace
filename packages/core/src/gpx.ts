/**
 * GPX parsing. `parseGpx` reads GPX 1.0 and 1.1 text from any exporter (Strava, Garmin, Apple
 * Health converters, RideWithGPS, onthegomap and so on) into courses, and throws a `GpxError`
 * with a message fit to show the user when the file cannot be used.
 *
 * What it accepts:
 * - every `<trk>` (its `<trkseg>`s joined in order) and every `<rte>` (its `<rtept>`s), each
 *   returned as a candidate course; `defaultTrack` is the longest
 * - prefixed or namespaced tags (matched by local name), a byte order mark, CDATA, comments,
 *   a doctype, CRLF line endings and entity references
 * - points with missing, unparseable or partial `<ele>`; a course whose every elevation is
 *   exactly 0 is treated as having none (exporters write 0 as a placeholder)
 *
 * What it cleans up, counted in `droppedPoints`:
 * - consecutive points at the same position, such as the run of fixes a watch records while
 *   standing still that differ only in `<time>` (the first is kept, borrowing a later one's
 *   elevation if it has none)
 * - points with a missing or invalid latitude or longitude, and points at exactly 0, 0 (a GPS
 *   "no fix" placeholder)
 *
 * Elevation quality (spikes, DEM fill) is not judged here; that is the elevation pipeline's job.
 */
import { type Course, type TrackPoint, buildCourse, courseLengthM } from "./course.ts";
import { XmlSyntaxError, decodeEntities, localName, tokenizeXml } from "./xml.ts";

/** Why a file could not be read as a course. */
export type GpxErrorCode =
  /** The file is empty or only whitespace. */
  | "empty"
  /** The file is not XML text at all (binary, JSON, plain text). */
  | "not-xml"
  /** The file is XML-like but broken or cut off. */
  | "malformed"
  /** The file is XML, but its root element is not `<gpx>` (KML, TCX, HTML). */
  | "not-gpx"
  /** No track or route has a usable point. */
  | "no-points"
  /** The usable points collapse to a single location. */
  | "single-point";

/** A file that cannot be loaded. `message` is written for the user. */
export class GpxError extends Error {
  override readonly name = "GpxError";
  constructor(
    readonly code: GpxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One candidate course in a GPX file. */
export interface GpxTrack {
  /** `track` for a `<trk>`, `route` for a `<rte>`. */
  kind: "track" | "route";
  /** The track's `<name>`, if it has one. */
  name?: string;
  /** Number of `<trkseg>` elements (1 for a route). */
  segmentCount: number;
  /** The cleaned points with cumulative distance; always at least two distinct positions. */
  course: Course;
  /** Points removed while cleaning (duplicates, invalid or placeholder coordinates). */
  droppedPoints: number;
}

/** A parsed GPX file. */
export interface GpxFile {
  /** The file's name from `<metadata><name>` (GPX 1.1) or `<gpx><name>` (GPX 1.0). */
  name?: string;
  /** The `creator` attribute of `<gpx>`. */
  creator?: string;
  /** Every usable track and route, in document order. Never empty. */
  tracks: GpxTrack[];
  /** Index into `tracks` of the one to show first: the longest (the first on a tie). */
  defaultTrack: number;
}

interface RawTrack {
  kind: "track" | "route";
  name?: string;
  segmentCount: number;
  points: TrackPoint[];
  dropped: number;
  /** Parsed points before deduplication, valid or not. */
  seen: number;
}

/** Element a text run is being collected for. */
type Capture = "ele" | "trackName" | "fileName" | null;

const NOT_GPX_HINTS: Record<string, string> = {
  kml: "a KML file (from Google Earth or Google My Maps)",
  trainingcenterdatabase: "a TCX file (Garmin Training Center)",
  html: "a web page",
  svg: "an SVG image",
  osm: "an OpenStreetMap data file",
};

const EXPORT_AS_GPX = "Export the course as GPX and try again.";

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

function parseCoordinate(raw: string | undefined, limit: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) && Math.abs(v) <= limit ? v : undefined;
}

function parseElevation(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const v = Number(trimmed);
  return Number.isFinite(v) ? v : undefined;
}

function rejectNonXml(text: string): void {
  const head = text.slice(0, 1024);
  if (head.includes("\0") || head.startsWith("PK")) {
    throw new GpxError(
      "not-xml",
      `This is not a GPX file: it looks like a binary file (such as a ZIP or FIT file). ${EXPORT_AS_GPX}`,
    );
  }
  const first = head.trimStart()[0];
  if (first !== "<") {
    throw new GpxError(
      "not-xml",
      `This is not a GPX file: GPX files are XML text starting with "<", and this one starts with "${first}". ${EXPORT_AS_GPX}`,
    );
  }
}

function notGpx(root: string): GpxError {
  const hint = NOT_GPX_HINTS[root.toLowerCase()];
  const what = hint ? `${hint}, not GPX` : `XML, but not GPX (its root element is <${root}>)`;
  return new GpxError("not-gpx", `This file is ${what}. ${EXPORT_AS_GPX}`);
}

/** Append a point, merging it into the previous one when they share a position. */
function pushPoint(track: RawTrack, p: TrackPoint): void {
  const prev = track.points.at(-1);
  if (prev && prev.lat === p.lat && prev.lon === p.lon) {
    if (prev.ele === undefined && p.ele !== undefined) prev.ele = p.ele;
    track.dropped++;
    return;
  }
  track.points.push(p);
}

/** Drop elevations from a track whose every elevation is exactly 0 (a placeholder). */
function dropPlaceholderElevation(points: TrackPoint[]): void {
  let any = false;
  for (const p of points) {
    if (p.ele === undefined) continue;
    if (p.ele !== 0) return;
    any = true;
  }
  if (any) for (const p of points) delete p.ele;
}

function scan(text: string): { file: Omit<GpxFile, "tracks" | "defaultTrack">; raw: RawTrack[]; waypoints: number } {
  const stack: string[] = [];
  const raw: RawTrack[] = [];
  const file: { name?: string; creator?: string } = {};
  let waypoints = 0;
  let rootClosed = false;
  let track: RawTrack | undefined;
  let point: { lat?: number; lon?: number; ele?: number } | undefined;
  let capture: Capture = null;
  let captureDepth = 0;
  let captured = "";

  function startCapture(what: Capture): void {
    capture = what;
    captureDepth = stack.length + 1;
    captured = "";
  }

  function endCapture(): void {
    const value = decodeEntities(captured).trim();
    if (capture === "ele" && point) {
      const ele = parseElevation(value);
      if (ele !== undefined) point.ele = ele;
    } else if (capture === "trackName" && track && value) {
      track.name = value;
    } else if (capture === "fileName" && value) {
      file.name = value;
    }
    capture = null;
  }

  function endPoint(t: RawTrack, p: NonNullable<typeof point>): void {
    t.seen++;
    const { lat, lon, ele } = p;
    if (lat === undefined || lon === undefined || (lat === 0 && lon === 0)) t.dropped++;
    else pushPoint(t, ele === undefined ? { lat, lon } : { lat, lon, ele });
  }

  function openPoint(attrs: ReadonlyMap<string, string>): void {
    let lat: string | undefined;
    let lon: string | undefined;
    for (const [k, v] of attrs) {
      const key = localName(k);
      if (key === "lat") lat = v;
      else if (key === "lon") lon = v;
    }
    point = {};
    const latV = parseCoordinate(lat, 90);
    const lonV = parseCoordinate(lon, 180);
    if (latV !== undefined) point.lat = latV;
    if (lonV !== undefined) point.lon = lonV;
  }

  tokenizeXml(text, {
    open(qname, attrs) {
      const name = localName(qname);
      const depth = stack.length;
      const parent = stack.at(-1);
      if (rootClosed || capture) {
        // Content after the root element, or markup nested inside a value being collected.
      } else if (depth === 0) {
        if (name !== "gpx") throw notGpx(name);
        const creator = attrs.get("creator")?.trim();
        if (creator) file.creator = creator;
      } else if (depth === 1 && (name === "trk" || name === "rte")) {
        track = { kind: name === "trk" ? "track" : "route", segmentCount: 0, points: [], dropped: 0, seen: 0 };
        raw.push(track);
      } else if (depth === 1 && name === "wpt") {
        waypoints++;
      } else if (track && depth === 2 && name === "trkseg" && parent === "trk") {
        track.segmentCount++;
      } else if (
        track &&
        ((depth === 3 && name === "trkpt" && parent === "trkseg") ||
          (depth === 2 && name === "rtept" && parent === "rte"))
      ) {
        openPoint(attrs);
      } else if (point && name === "ele" && (parent === "trkpt" || parent === "rtept")) {
        startCapture("ele");
      } else if (track && depth === 2 && name === "name") {
        startCapture("trackName");
      } else if (name === "name" && (depth === 1 || (depth === 2 && parent === "metadata"))) {
        startCapture("fileName");
      }
      stack.push(name);
    },
    close(qname, offset) {
      const name = localName(qname);
      const top = stack.pop();
      if (top !== name) {
        const expected = top === undefined ? "nothing" : `</${top}>`;
        throw new GpxError(
          "malformed",
          `This GPX file is damaged: it has </${name}> where ${expected} was expected (line ${lineAt(text, offset)}).`,
        );
      }
      const depth = stack.length;
      if (rootClosed) return;
      if (depth === 0) {
        rootClosed = true;
      } else if (capture) {
        if (depth + 1 === captureDepth) endCapture();
      } else if (point && track && (name === "trkpt" ? depth === 3 : name === "rtept" && depth === 2)) {
        endPoint(track, point);
        point = undefined;
      } else if (track && depth === 1) {
        if (track.kind === "route") track.segmentCount = 1;
        track = undefined;
      }
    },
    text(chunk, cdata) {
      if (capture) {
        captured += cdata ? chunk.replace(/&/g, "&amp;") : chunk;
      } else if (stack.length === 0 && !rootClosed && chunk.trim() !== "") {
        throw new GpxError("not-xml", `This is not a GPX file: it has text outside any XML element. ${EXPORT_AS_GPX}`);
      }
    },
  });

  if (!rootClosed) {
    if (stack.length === 0) throw new GpxError("not-gpx", `This file has no GPX content. ${EXPORT_AS_GPX}`);
    throw new GpxError(
      "malformed",
      `This GPX file looks cut off: it ends inside <${stack.at(-1) ?? "gpx"}>. Try exporting or downloading it again.`,
    );
  }
  return { file, raw, waypoints };
}

function noPointsError(raw: readonly RawTrack[], waypoints: number): GpxError {
  const seen = raw.reduce((sum, t) => sum + t.seen, 0);
  if (seen > 0) {
    return new GpxError(
      "no-points",
      `This GPX file has ${seen === 1 ? "a track point" : `${seen} track points`}, but none with a valid latitude and longitude.`,
    );
  }
  if (waypoints > 0) {
    const count = waypoints === 1 ? "1 waypoint" : `${waypoints} waypoints`;
    return new GpxError(
      "no-points",
      `This GPX file has only ${count}, which mark places rather than a path. Export the course as a track or route.`,
    );
  }
  return new GpxError("no-points", "This GPX file has no track or route points, so there is no course to show.");
}

/**
 * Parse GPX text into its candidate courses. Throws a `GpxError` (and nothing else) when the
 * text cannot be used; its `message` is meant for the user and its `code` for the program.
 */
export function parseGpx(text: string): GpxFile {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") throw new GpxError("empty", "This file is empty.");
  rejectNonXml(body);

  let scanned: ReturnType<typeof scan>;
  try {
    scanned = scan(body);
  } catch (e) {
    if (!(e instanceof XmlSyntaxError)) throw e;
    const where = `line ${lineAt(body, e.offset)}`;
    const message = e.truncated
      ? `This GPX file looks cut off: it ends with an ${e.message.replace(/^unterminated /, "unfinished ")} (${where}). Try exporting or downloading it again.`
      : `This GPX file is damaged: ${e.message} (${where}).`;
    throw new GpxError("malformed", message);
  }
  const { file, raw, waypoints } = scanned;

  const tracks: GpxTrack[] = [];
  for (const t of raw) {
    if (t.points.length < 2) continue;
    dropPlaceholderElevation(t.points);
    const track: GpxTrack = {
      kind: t.kind,
      segmentCount: t.segmentCount,
      course: buildCourse(t.points),
      droppedPoints: t.dropped,
    };
    if (t.name !== undefined) track.name = t.name;
    tracks.push(track);
  }

  if (tracks.length === 0) {
    if (raw.some((t) => t.points.length === 1)) {
      throw new GpxError(
        "single-point",
        "This GPX file has only one distinct point, so there is no course to show. A course needs at least two.",
      );
    }
    throw noPointsError(raw, waypoints);
  }

  let defaultTrack = 0;
  tracks.forEach((t, i) => {
    if (courseLengthM(t.course) > courseLengthM((tracks[defaultTrack] as GpxTrack).course)) defaultTrack = i;
  });
  return { ...file, tracks, defaultTrack };
}
