/**
 * The map's camera across visits (B10): where the user last looked comes back on the next visit.
 *
 * - **Saving.** The camera (center and zoom) is written to local storage (`pp:camera`, versioned
 *   like the session) once the map rests (`moveend`, debounced), and right away when the page
 *   hides. Storage can be missing, full or blocked: every access is guarded.
 * - **Start-up framing.** `startFraming` picks the first view: a share link frames its course;
 *   otherwise the saved camera; otherwise a restored session course is fit as before; otherwise
 *   the default whole-US view. A saved camera that is corrupt or out of range is ignored.
 * - **Keeping the saved view.** When the saved camera wins over a restored course, the map starts
 *   there and that course is drawn without moving the camera (`keepsStartCamera`). Any other
 *   course (a new file, a new drawing, a pasted link) is framed as always.
 */
import type { LatLon } from "@pp/core";

export const CAMERA_STORAGE_KEY = "pp:camera";
const CAMERA_VERSION = 1;
/** Quiet time after the map rests before the camera is written. */
export const CAMERA_SAVE_DEBOUNCE_MS = 400;
/** Web Mercator's latitude limit: the map cannot center further north or south. */
export const MAX_CAMERA_LAT = 85.051129;
/** MapLibre's zoom range (its defaults, which the map keeps). */
export const MIN_CAMERA_ZOOM = 0;
export const MAX_CAMERA_ZOOM = 22;

/** A map view: the point in the middle of the map, and the zoom level. */
export interface MapCamera {
  center: LatLon;
  zoom: number;
}

interface SavedCamera {
  v: number;
  lat: number;
  lon: number;
  zoom: number;
}

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** The camera kept in `text`, or undefined when there is none, or it is corrupt or out of range. */
export function parseCamera(text: string | null): MapCamera | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<SavedCamera> | null;
    if (!value || typeof value !== "object" || value.v !== CAMERA_VERSION) return undefined;
    const { lat, lon, zoom } = value;
    if (!inRange(lat, -MAX_CAMERA_LAT, MAX_CAMERA_LAT) || !inRange(lon, -180, 180)) return undefined;
    if (!inRange(zoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM)) return undefined;
    return { center: { lat, lon }, zoom };
  } catch {
    return undefined;
  }
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** The stored form of a camera (about 10 cm and a thousandth of a zoom level of precision). */
export function serializeCamera(camera: MapCamera): string {
  const saved: SavedCamera = {
    v: CAMERA_VERSION,
    lat: round(camera.center.lat, 6),
    lon: round(camera.center.lon, 6),
    zoom: round(camera.zoom, 3),
  };
  return JSON.stringify(saved);
}

/** The saved camera, if there is a usable one. */
export function readCamera(storage: Pick<Storage, "getItem"> | undefined): MapCamera | undefined {
  try {
    return parseCamera(storage?.getItem(CAMERA_STORAGE_KEY) ?? null);
  } catch {
    return undefined;
  }
}

/** Keep the camera for the next visit. Failures are ignored: the map works the same without it. */
export function writeCamera(storage: Pick<Storage, "setItem"> | undefined, camera: MapCamera): void {
  try {
    storage?.setItem(CAMERA_STORAGE_KEY, serializeCamera(camera));
  } catch {
    // Storage can be full or blocked.
  }
}

/** How the map frames its first view. */
export type StartFraming =
  /** Start at the whole-US view and frame the share link's course once it is drawn. */
  | { kind: "share" }
  /** Start at the saved camera, and leave it there when the restored course is drawn. */
  | { kind: "saved"; camera: MapCamera }
  /** Start at the whole-US view and frame the restored session course once it is drawn. */
  | { kind: "session" }
  /** The whole-US view. */
  | { kind: "default" };

export interface StartInputs {
  /** The page was opened with a share link that can be read. */
  shareLink: boolean;
  /** The saved camera, already checked (`parseCamera`). */
  savedCamera: MapCamera | undefined;
  /** The saved session has a course to restore. */
  sessionCourse: boolean;
}

/** The start-up framing precedence: share link, then saved camera, then session course, then default. */
export function startFraming({ shareLink, savedCamera, sessionCourse }: StartInputs): StartFraming {
  if (shareLink) return { kind: "share" };
  if (savedCamera) return { kind: "saved", camera: savedCamera };
  if (sessionCourse) return { kind: "session" };
  return { kind: "default" };
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The saved camera in this browser's storage. */
export const readSavedCamera = (): MapCamera | undefined => readCamera(browserStorage());

let pending: MapCamera | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Write the camera waiting to be saved, if any. */
function flushCamera(): void {
  clearTimeout(timer);
  timer = undefined;
  if (pending) writeCamera(browserStorage(), pending);
  pending = null;
}

/** Save the camera once the map has rested for a moment (each call restarts the wait). */
export function saveCamera(camera: MapCamera): void {
  pending = camera;
  clearTimeout(timer);
  timer = setTimeout(flushCamera, CAMERA_SAVE_DEBOUNCE_MS);
}

/** Write a waiting camera when the page hides, so a reload never loses the last move. Returns the stop function. */
export function startCameraSaving(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flushCamera();
  };
  window.addEventListener("pagehide", flushCamera);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    flushCamera();
    window.removeEventListener("pagehide", flushCamera);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Whether the course being restored keeps the start camera: `pending` until its route reaches the
 * map, then that route (so drawing the same route again, as React's development double effects
 * do, keeps it too).
 */
let startHold: "off" | "pending" | { route: object } = "off";

/** The next course drawn is the restored one: keep the saved camera for it instead of framing it. */
export function holdStartCamera(): void {
  startHold = "pending";
}

/** Another course is coming (or the restore found none): frame it as usual. */
export function releaseStartCamera(): void {
  if (startHold === "pending") startHold = "off";
}

/** Asked for each new route: true when it is the restored course, which keeps the saved camera. */
export function keepsStartCamera(route: object): boolean {
  if (startHold === "pending") {
    startHold = { route };
    return true;
  }
  return startHold !== "off" && startHold.route === route;
}
