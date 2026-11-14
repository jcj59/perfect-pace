import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GpxError,
  type GpxErrorCode,
  type GpxFile,
  METERS_PER_MILE,
  type TrackPoint,
  courseLengthM,
  parseGpx,
} from "../src/index.ts";
import { DIALECTS, isRouteDialect, toGpx } from "./support/gpx-dialects.ts";
import { mulberry32 } from "./support/rng.ts";
import { randomTrack } from "./support/tracks.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "gpx");
const INVALID = join(FIXTURES, "invalid");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const gpxFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".gpx"));

const wrap = (body: string): string =>
  `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;
const seg = (...pts: string[]): string => `<trk><trkseg>${pts.join("")}</trkseg></trk>`;
const pt = (lat: number, lon: number, inner = ""): string => `<trkpt lat="${lat}" lon="${lon}">${inner}</trkpt>`;

function only(file: GpxFile) {
  expect(file.tracks).toHaveLength(1);
  return file.tracks[0]!;
}

const positions = (file: GpxFile, i = file.defaultTrack): TrackPoint[] =>
  file.tracks[i]!.course.points.map(({ lat, lon, ele }) => (ele === undefined ? { lat, lon } : { lat, lon, ele }));

function gpxError(text: string): GpxError {
  try {
    parseGpx(text);
  } catch (e) {
    if (e instanceof GpxError) return e;
    throw e;
  }
  throw new Error("expected a GpxError");
}

describe("parseGpx on the fixture corpus", () => {
  it.each(gpxFiles(FIXTURES))("parses %s into at least one course", (name) => {
    const file = parseGpx(fixture(name));
    expect(file.tracks.length).toBeGreaterThan(0);
    for (const t of file.tracks) {
      expect(t.course.points.length).toBeGreaterThanOrEqual(2);
      expect(courseLengthM(t.course)).toBeGreaterThan(0);
    }
  });

  it("measures Boston at 26.2 miles within 0.5%", () => {
    const miles = courseLengthM(parseGpx(fixture("boston.gpx")).tracks[0]!.course) / METERS_PER_MILE;
    expect(Math.abs(miles - 26.2188) / 26.2188).toBeLessThan(0.005);
  });

  it("joins multiple segments in order", () => {
    const t = only(parseGpx(fixture("multi-segment.gpx")));
    expect(t.segmentCount).toBe(4);
    expect(t.name).toBe("Paused twice");
    expect(t.course.points.map((p) => p.lat)).toEqual([42.438, 42.439, 42.44, 42.441, 42.442, 42.443, 42.444]);
    expect(t.course.points.map((p) => p.ele)).toEqual([120, 121, 122, 123, 124, 125, 126]);
  });

  it("returns every track and route of a multi-track file and defaults to the longest", () => {
    const file = parseGpx(fixture("multi-track.gpx"));
    expect(file.name).toBe("Race day");
    expect(file.tracks.map((t) => [t.kind, t.name])).toEqual([
      ["track", "Warm-up"],
      ["track", "Race"],
      ["route", "Cool-down"],
    ]);
    expect(file.defaultTrack).toBe(1);
  });

  it("reads routes", () => {
    const route = only(parseGpx(fixture("ridewithgps-route.gpx")));
    const track = only(parseGpx(fixture("ridewithgps-track.gpx")));
    expect(route.kind).toBe("route");
    expect(route.segmentCount).toBe(1);
    expect(route.course.points).toEqual(track.course.points);
  });

  it("matches tags by local name, ignoring prefixes and extension elements", () => {
    const file = parseGpx(fixture("prefixed-namespace.gpx"));
    expect(file.name).toBe("Prefixed");
    expect(only(file).name).toBe("Prefixed track");
    expect(positions(file).map((p) => p.ele)).toEqual([120.5, 121.5, 122.5]);
  });

  it("handles a BOM, CRLF, a doctype, CDATA, comments and entities", () => {
    const file = parseGpx(fixture("bom-crlf-cdata.gpx"));
    expect(fixture("bom-crlf-cdata.gpx").charCodeAt(0)).toBe(0xfeff);
    expect(file.name).toBe("Fish & Chips <5K>");
    expect(file.creator).toBe("Notepad & friends");
    expect(only(file).name).toBe("Café loop → home");
    expect(positions(file)).toEqual([
      { lat: 42.438, lon: -76.499, ele: 120 },
      { lat: 42.439, lon: -76.499, ele: 121 },
      { lat: 42.44, lon: -76.499, ele: 122 },
    ]);
  });

  it("reads GPX 1.0", () => {
    const file = parseGpx(fixture("gpx-1.0.gpx"));
    expect(file.name).toBe("Converted run");
    expect(only(file).name).toBe("ACTIVE LOG");
    expect(positions(file).map((p) => p.ele)).toEqual([120, 121, 122]);
  });

  it("keeps a course without elevation", () => {
    expect(positions(parseGpx(fixture("no-elevation.gpx"))).every((p) => p.ele === undefined)).toBe(true);
  });

  it("keeps partial elevation and skips empty or unparseable values", () => {
    expect(positions(parseGpx(fixture("partial-elevation.gpx"))).map((p) => p.ele)).toEqual([
      120,
      undefined,
      undefined,
      undefined,
      0,
      -3.5,
    ]);
  });

  it("treats all-zero elevation as missing", () => {
    expect(positions(parseGpx(fixture("zero-elevation.gpx"))).every((p) => p.ele === undefined)).toBe(true);
  });

  it("drops duplicates, timestamp-only noise and invalid points", () => {
    const t = only(parseGpx(fixture("duplicates-and-noise.gpx")));
    expect(t.droppedPoints).toBe(10);
    expect(positions(parseGpx(fixture("duplicates-and-noise.gpx")))).toEqual([
      { lat: 42.438, lon: -76.499, ele: 120 },
      { lat: 42.439, lon: -76.499, ele: 121 },
      { lat: 42.44, lon: -76.499, ele: 122 },
      { lat: 42.441, lon: -76.499, ele: 123 },
      { lat: 42.442, lon: -76.499, ele: 124 },
      { lat: 42.443, lon: -76.499, ele: 125 },
    ]);
  });

  it("collapses a watch standing still in real activity exports", () => {
    expect(only(parseGpx(fixture("strava-activity.gpx"))).droppedPoints).toBe(12);
    expect(only(parseGpx(fixture("garmin-connect-activity.gpx"))).droppedPoints).toBe(8);
  });

  it("reads Apple Health's lon-before-lat points", () => {
    const [first] = positions(parseGpx(fixture("apple-health-route.gpx")));
    expect(first).toEqual({ lat: 42.4387, lon: -76.4951, ele: 251.3 });
  });
});

describe("parseGpx errors", () => {
  it.each<[string, GpxErrorCode, RegExp]>([
    ["empty.gpx", "empty", /^This file is empty\.$/],
    ["not-xml.gpx", "not-xml", /starts with "\{"/],
    ["binary-fit.gpx", "not-xml", /binary file/],
    ["kml.gpx", "not-gpx", /KML file/],
    ["tcx.gpx", "not-gpx", /TCX file/],
    ["html-page.gpx", "not-gpx", /web page/],
    ["metadata-only.gpx", "no-points", /no track or route points/],
    ["waypoints-only.gpx", "no-points", /only 3 waypoints/],
    ["invalid-coordinates.gpx", "no-points", /4 track points, but none with a valid latitude/],
    ["single-point.gpx", "single-point", /only one distinct point/],
    ["standing-still.gpx", "single-point", /only one distinct point/],
    ["truncated.gpx", "malformed", /looks cut off: it ends inside <trkpt>/],
    ["mismatched-tags.gpx", "malformed", /<\/trkpt> where <\/ele> was expected \(line 6\)/],
  ])("rejects %s as %s", (name, code, message) => {
    const e = gpxError(readFileSync(join(INVALID, name), "utf8"));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
    expect(e.name).toBe("GpxError");
  });

  it("covers every invalid fixture", () => {
    expect(gpxFiles(INVALID)).toHaveLength(13);
  });

  it.each<[string, string, GpxErrorCode, RegExp]>([
    ["whitespace", " \r\n\t", "empty", /empty/],
    ["a BOM alone", "﻿", "empty", /empty/],
    ["a ZIP", "PK\u0003\u0004", "not-xml", /binary/],
    ["only a declaration", '<?xml version="1.0"?>', "not-gpx", /no GPX content/],
    ["text before the root", "<!-- x --> hello <gpx></gpx>", "not-xml", /text outside/],
    ["an unknown root", "<foo/>", "not-gpx", /root element is <foo>/],
    ["an unterminated comment", wrap("<!-- x"), "malformed", /cut off: it ends with an unfinished comment \(line 1\)/],
    ["a broken attribute", wrap("<trk x=1>"), "malformed", /damaged: a tag has a malformed attribute/],
    ["a stray end tag", "<gpx></gpx></trk>", "malformed", /<\/trk> where nothing was expected/],
    ["a single-point route", wrap('<rte><rtept lat="1" lon="1"/></rte>'), "single-point", /one distinct point/],
    ["one waypoint", wrap('<wpt lat="1" lon="1"/>'), "no-points", /only 1 waypoint,/],
    ["one bad point", wrap(seg('<trkpt lat="x" lon="1"/>')), "no-points", /has a track point, but none/],
  ])("rejects %s", (_label, text, code, message) => {
    const e = gpxError(text);
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
  });

  it("reports the line of a damaged tag", () => {
    expect(gpxError(wrap("\n\n<trk>\n</trkseg>")).message).toMatch(/\(line 4\)/);
  });

  // Seeded fuzzing: cut, splice and corrupt real files; the parser returns or throws a GpxError.
  it("never throws anything but a GpxError", () => {
    const seed = 3141;
    const next = mulberry32(seed);
    const sources = gpxFiles(FIXTURES).map(fixture);
    const junk = ["<", ">", "</trkpt>", "<trkseg>", '"', "&", "]]>", "<![CDATA[", "<!--", "\u0000", "lat=", "<gpx>"];
    for (let i = 0; i < 400; i++) {
      let text = sources[Math.floor(next() * sources.length)]!;
      const at = Math.floor(next() * text.length);
      const op = next();
      if (op < 0.3) text = text.slice(0, at);
      else if (op < 0.6) text = text.slice(0, at) + junk[Math.floor(next() * junk.length)]! + text.slice(at);
      else text = text.slice(0, at) + text.slice(at + Math.floor(next() * 200));
      try {
        parseGpx(text);
      } catch (e) {
        expect(e, `seed ${seed}, iteration ${i}`).toBeInstanceOf(GpxError);
      }
    }
  });
});

describe("parseGpx details", () => {
  it("ignores <ele> inside extensions and content after the root", () => {
    const file = parseGpx(
      wrap(seg(pt(1, 1, "<extensions><ele>9</ele></extensions>"), pt(1, 2, "<ele>5</ele>"))) + "<gpx><trk/></gpx>",
    );
    expect(positions(file)).toEqual([
      { lat: 1, lon: 1 },
      { lat: 1, lon: 2, ele: 5 },
    ]);
  });

  it("collects text split by comments and ignores markup nested in a name", () => {
    const file = parseGpx(
      wrap(
        `<trk><name>Big <b>loop</b> run</name><trkseg>${pt(1, 1, "<ele>1<!-- c -->2</ele>")}${pt(1, 2)}</trkseg></trk>`,
      ),
    );
    expect(only(file).name).toBe("Big loop run");
    expect(positions(file)[0]?.ele).toBe(12);
  });

  it("leaves names undefined when blank and picks the first of equally long tracks", () => {
    const file = parseGpx(
      wrap(`<trk><name> </name><trkseg>${pt(1, 1)}${pt(1, 2)}</trkseg></trk>${seg(pt(1, 1), pt(1, 2))}`),
    );
    expect(file.tracks[0]?.name).toBeUndefined();
    expect(file.name).toBeUndefined();
    expect(file.creator).toBe("t");
    expect(file.defaultTrack).toBe(0);
  });

  it("borrows a later duplicate's elevation", () => {
    expect(positions(parseGpx(wrap(seg(pt(1, 1), pt(1, 1, "<ele>7</ele>"), pt(1, 2)))))).toEqual([
      { lat: 1, lon: 1, ele: 7 },
      { lat: 1, lon: 2 },
    ]);
  });

  it("accepts the boundary coordinates and exponent notation", () => {
    expect(positions(parseGpx(wrap(seg(pt(90, 180), '<trkpt lat="-9e1" lon="-1.8E2"/>'))))).toEqual([
      { lat: 90, lon: 180 },
      { lat: -90, lon: -180 },
    ]);
  });
});

describe("parseGpx round trip", () => {
  // Generate a track, write it in each dialect, parse it back: the points must match exactly
  // after removing consecutive duplicates.
  const seeds = [11, 12, 13, 14, 15, 16];
  const cases = seeds.flatMap((seed) => DIALECTS.map((dialect) => [dialect, seed] as const));

  it.each(cases)("%s, seed %i", (dialect, seed) => {
    const next = mulberry32(seed);
    const withEle = next() < 0.7;
    const track = randomTrack(seed, {
      count: 20 + Math.floor(next() * 300),
      minStepM: 1,
      maxStepM: 30,
      maxTurnDeg: 40,
      duplicateChance: 0.1,
      withEle,
    });
    const segments = 1 + Math.floor(next() * 4);
    const name = `Run #${seed} & <friends>`;
    const file = parseGpx(toGpx(dialect, track, { name, segments }));

    const expected = track.filter((p, i) => i === 0 || p.lat !== track[i - 1]!.lat || p.lon !== track[i - 1]!.lon);
    const t = only(file);
    expect(positions(file), `seed ${seed}`).toEqual(expected);
    expect(t.droppedPoints, `seed ${seed}`).toBe(track.length - expected.length);
    expect(t.kind).toBe(isRouteDialect(dialect) ? "route" : "track");
    expect(t.name).toBe(name);
    if (!isRouteDialect(dialect)) expect(t.segmentCount).toBe(Math.min(segments, track.length));
  });
});
