/**
 * Loading a course from a GPX file: read it, parse it in the core worker, then build the selected
 * track's elevation profile there too. Each step writes `course` in the app store; a newer file (or
 * track) aborts whatever the previous one still had in flight, so only the latest result lands.
 */
import type { GpxFile, LatLon } from "@pp/core";
import { buildCourse } from "@pp/core";
import { coreClient } from "../worker/client.ts";
import { RpcError } from "../worker/rpc.ts";
import { type CourseState, appStore, setCourse, setSheet } from "./app.ts";

/** Larger files are refused before reading. A 50k-point Garmin activity is about 19 MB. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Performance marks around a load, read by `e2e/tests/perf.spec.ts`. */
export const LOAD_START_MARK = "pp:load-start";
export const ROUTE_DRAWN_MARK = "pp:route-drawn";
export const LOAD_MEASURE = "pp:load-course";
export const PARSED_MARK = "pp:parsed";

const UNREADABLE =
  "Something went wrong while reading this file. Try again, or export it again from where it came from.";

const ELEVATION_MESSAGES: Record<string, string> = {
  fetch: "Elevation data could not be downloaded. Check your connection and try again.",
  decode: "Elevation data for this area could not be read. Try again in a moment.",
};
const ELEVATION_FALLBACK = "Elevation could not be worked out for this course. Try again in a moment.";

let load: AbortController | undefined;
let elevation: AbortController | undefined;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** The message to show for a file that did not load. Parser errors are already written for people. */
export function loadErrorMessage(error: unknown): string {
  if (error instanceof RpcError && error.errorName === "GpxError") return error.message;
  return UNREADABLE;
}

/** The message to show when the elevation profile failed. */
export function elevationErrorMessage(error: unknown): string {
  if (error instanceof RpcError && error.errorName === "ElevationError") {
    return ELEVATION_MESSAGES[error.code ?? ""] ?? ELEVATION_FALLBACK;
  }
  return ELEVATION_FALLBACK;
}

/** Bring the phone sheet up from `peek` so the result (or the error) is in view. */
function raiseSheet(): void {
  if (appStore.get().sheet === "peek") setSheet("half");
}

/**
 * Told the text of each GPX file that loads, with what it parsed to, so the session can keep it
 * for the next visit (see `session.ts`).
 */
let fileSink: ((text: string, file: GpxFile, fileName: string) => void) | undefined;
export function onGpxText(sink: typeof fileSink): void {
  fileSink = sink;
}

function startLoad(): AbortSignal {
  load?.abort();
  elevation?.abort();
  const controller = new AbortController();
  load = controller;
  return controller.signal;
}

/** Load a GPX file the user picked or dropped. Resolves once it has loaded or failed (never rejects). */
export async function loadGpxFile(file: File): Promise<void> {
  const signal = startLoad();
  const fileName = file.name || "This file";

  performance.clearMarks(LOAD_START_MARK);
  performance.clearMarks(ROUTE_DRAWN_MARK);
  performance.clearMarks(PARSED_MARK);
  performance.clearMeasures(LOAD_MEASURE);
  performance.mark(LOAD_START_MARK);
  setCourse({ status: "reading", fileName }, true);

  try {
    if (file.size > MAX_FILE_BYTES) {
      setCourse({
        status: "error",
        fileName,
        code: "too-large",
        message: `This file is ${Math.round(file.size / 1024 / 1024)} MB, more than any course needs. GPX files of whole races are usually under 20 MB.`,
      });
      raiseSheet();
      return;
    }
    const text = await file.text();
    if (signal.aborted) return;
    const gpx = await coreClient().call("parse", { text }, { signal });
    performance.mark(PARSED_MARK);
    fileSink?.(text, gpx, fileName);
    showTrack({ status: "loaded", fileName, file: gpx, track: gpx.defaultTrack, elevation: { status: "loading" } });
    raiseSheet();
  } catch (error) {
    if (isAbort(error) || signal.aborted) return;
    if (!(error instanceof RpcError && error.errorName === "GpxError"))
      console.error("Could not load", fileName, error);
    const code = error instanceof RpcError ? error.code : undefined;
    setCourse({ status: "error", fileName, ...(code ? { code } : {}), message: loadErrorMessage(error) });
    raiseSheet();
  }
}

/**
 * Load GPX text kept from an earlier visit, showing track `track` (the default when out of range).
 * Resolves true once the course is in the store (before its elevation), false when it did not
 * parse or a newer load took over.
 */
export async function loadGpxText(text: string, fileName: string, track: number): Promise<boolean> {
  const signal = startLoad();
  setCourse({ status: "reading", fileName }, true);
  try {
    const gpx = await coreClient().call("parse", { text }, { signal });
    // Anything the person did meanwhile (drawing, say) wins over the restore.
    const current = appStore.get().course;
    if (signal.aborted || current.status !== "reading" || current.fileName !== fileName) return false;
    fileSink?.(text, gpx, fileName);
    const index = Number.isInteger(track) && gpx.tracks[track] ? track : gpx.defaultTrack;
    showTrack({ status: "loaded", fileName, file: gpx, track: index, elevation: { status: "loading" } }, true);
    return true;
  } catch (error) {
    if (isAbort(error) || signal.aborted || appStore.get().course.status !== "reading") return false;
    console.error("Could not restore", fileName, error);
    setCourse({ status: "empty" }, true);
    return false;
  }
}

/**
 * Show a simplified course: one from a share link (`copy: "link"`), or a saved copy of a file too
 * large to keep whole (`copy: "saved"`). Its elevation always comes from terrain data, since the
 * copy carries none. Synchronous: the course is in the store when it returns.
 */
export function loadCourseCopy(points: readonly LatLon[], name: string, copy: "link" | "saved"): void {
  startLoad();
  const course = buildCourse(points);
  const file: GpxFile = {
    name,
    tracks: [{ kind: "track", name, segmentCount: 1, course, droppedPoints: 0 }],
    defaultTrack: 0,
  };
  showTrack({ status: "loaded", fileName: name, file, track: 0, copy, elevation: { status: "loading" } }, true);
  raiseSheet();
}

/** Switch to another track or route in a multi-track file. */
export function selectTrack(index: number): void {
  const course = appStore.get().course;
  if (course.status !== "loaded" || index === course.track || !course.file.tracks[index]) return;
  showTrack({ ...course, track: index, elevation: { status: "loading" } }, true);
}

/** Build the elevation profile again after it failed (for example while offline). */
export function retryElevation(): void {
  const course = appStore.get().course;
  if (course.status !== "loaded" || course.elevation.status !== "error") return;
  showTrack({ ...course, elevation: { status: "loading" } });
}

type Loaded = Extract<CourseState, { status: "loaded" }>;

/** Show a track right away (route and distance), then fill in its elevation profile. */
function showTrack(course: Loaded, fresh = false): void {
  elevation?.abort();
  const controller = new AbortController();
  elevation = controller;
  setCourse(course, fresh);
  const track = course.file.tracks[course.track];
  if (!track) return;
  let current: CourseState = course;
  const stillCurrent = () => !controller.signal.aborted && appStore.get().course === current;
  coreClient()
    // A simplified copy has no elevation of its own: it always comes from terrain data, as for a drawn route.
    .call("elevation", { course: track.course, origin: course.copy ? "drawn" : "file" }, { signal: controller.signal })
    .then(
      (profile) => {
        if (!stillCurrent()) return;
        current = { ...course, elevation: { status: "ready", profile } };
        setCourse(current);
        performance.mark("pp:elevation-ready");
      },
      (error: unknown) => {
        if (isAbort(error) || !stillCurrent()) return;
        console.error("Could not build the elevation profile", error);
        current = { ...course, elevation: { status: "error", message: elevationErrorMessage(error) } };
        setCourse(current);
      },
    );
}

/** The name to show for a track: its own, else the file's, else the file name without `.gpx`. */
export function trackTitle(file: GpxFile, index: number, fileName: string): string {
  const track = file.tracks[index];
  if (track?.name) return track.name;
  if (file.tracks.length === 1 && file.name) return file.name;
  if (file.tracks.length > 1) {
    const sameKind = file.tracks.slice(0, index + 1).filter((t) => t.kind === track?.kind).length;
    return `${track?.kind === "route" ? "Route" : "Track"} ${sameKind}`;
  }
  return fileName.replace(/\.gpx$/i, "") || "Course";
}
