/**
 * Share links and the saved session.
 *
 * - **Share links.** `shareLink` builds the link for the course on screen and its plan inputs
 *   (see `@pp/core`'s `share.ts` for the format). Opening the app with one, or pasting one into
 *   the address bar while it is open, loads that course and those inputs; the fragment is then
 *   taken off the address so a reload does not undo later changes. A link that cannot be read
 *   leaves a message in the panel (`AppState.linkError`), and the saved session loads instead.
 * - **The saved session.** The last course and plan inputs are kept in local storage and come
 *   back on the next visit. A drawn route keeps its waypoints and leg modes. A loaded file keeps
 *   its own text, so it comes back exactly; one too large for storage keeps a simplified copy
 *   instead (whose elevation then comes from terrain data, and the panel says so). Storage can be
 *   missing, full or blocked: every access is guarded, and the app works the same without it.
 */
import {
  type DrawnRoute,
  type GpxFile,
  type LatLon,
  ShareError,
  DEFAULT_CURVE_MAX_PACE_CHANGES,
  MAX_SHARE_GOAL_S,
  type ShareTrack,
  type SharedCourse,
  type SharedPlan,
  type SharedSettings,
  buildShareLink,
  encodeShare,
  decodeShare,
  decodeSharedCourse,
  encodeSharedCourse,
  isShareFragment,
  simplifyForShare,
} from "@pp/core";
import { type AppState, type PlanSettings, appStore, applyPlanSettings, setLinkError, setSheet } from "./app.ts";
import { loadCourseCopy, loadGpxText, onGpxText, trackTitle } from "./course.ts";
import { type DrawState, drawStore, drawing } from "./draw.ts";

export const SESSION_STORAGE_KEY = "pp:session";
/** The loaded file's text, kept apart from the session so plan changes never rewrite it. */
export const SESSION_GPX_STORAGE_KEY = "pp:session-gpx";
const SESSION_VERSION = 1;
/** Quiet time after a change before the session is written (and always when the page hides). */
const SAVE_DEBOUNCE_MS = 300;
/**
 * The longest GPX text kept whole, in characters. Local storage holds about 5 million characters
 * per site; this leaves room for everything else.
 */
const MAX_STORED_GPX_CHARS = 2_500_000;
/** The most characters a saved simplified copy may take. */
const SAVED_COPY_MAX_CHARS = 400_000;

type SavedCourse =
  | { kind: "file"; fileName: string; track: number }
  | { kind: "copy"; copy: "link" | "saved"; name: string; c: string }
  | { kind: "drawn"; c: string };

interface SavedSession {
  v: number;
  course: SavedCourse | null;
  goalTimeS: number | null;
  paceChanges: number;
  minSegmentM: number;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a value, or remove it with null. False when storage refused (full, blocked or missing). */
function write(key: string, value: string | null): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The plan as a share link carries it: the course on screen and the plan inputs. Undefined with no course. */
export function sharedPlan(state: AppState, draws: DrawState): SharedPlan | undefined {
  const settings = {
    goalTimeS: state.goalTimeS,
    paceChanges: state.paceChanges,
    minSegmentM: state.minSegmentM,
    unit: state.units,
  };
  const { course } = state;
  if (course.status === "drawn") {
    const route = draws.history.present;
    return route.waypoints.length >= 2 ? { course: { kind: "drawn", route }, settings } : undefined;
  }
  if (course.status !== "loaded") return undefined;
  const track = course.file.tracks[course.track];
  if (!track) return undefined;
  return {
    course: { kind: "track", points: track.course.points },
    settings,
    name: trackTitle(course.file, course.track, course.fileName),
  };
}

/** The longest plan inputs a link can carry, so a course that fits with these fits with any. */
const LONGEST_SETTINGS: SharedSettings = {
  goalTimeS: MAX_SHARE_GOAL_S,
  paceChanges: DEFAULT_CURVE_MAX_PACE_CHANGES,
  minSegmentM: 1609.344,
  unit: "mi",
};

/** The course as a share link will carry it (an uploaded one simplified), ready for any inputs. */
export interface PreparedShare {
  course: SharedCourse;
  name?: string;
  /** For an uploaded course, how it was simplified. */
  track?: ShareTrack;
}

/** The page links point at: this one, without its query or fragment. */
export const shareBase = (): string => `${location.origin}${location.pathname}`;

/**
 * Get a course ready to share: simplified to fit a link with room for any plan inputs. This is
 * the slow part (for a long track), so it runs once per course, not on every input change.
 * Undefined when the course is too large for a link.
 */
export function prepareShare(plan: SharedPlan, base = shareBase()): PreparedShare | undefined {
  const link = buildShareLink(base, { ...plan, settings: LONGEST_SETTINGS });
  if (!link) return undefined;
  const course: SharedCourse = link.track ? { kind: "track", points: link.track.points } : plan.course;
  return { course, ...(plan.name ? { name: plan.name } : {}), ...(link.track ? { track: link.track } : {}) };
}

/** The link for a prepared course with these plan inputs. */
export function shareUrl(prepared: PreparedShare, settings: SharedSettings, base = shareBase()): string {
  const plan: SharedPlan = { course: prepared.course, settings, ...(prepared.name ? { name: prepared.name } : {}) };
  return `${base}#${encodeShare(plan)}`;
}

function settingsOf(plan: SharedPlan): PlanSettings {
  const { goalTimeS, paceChanges, minSegmentM, unit } = plan.settings;
  return { goalTimeS, paceChanges, minSegmentM, units: unit };
}

/** Load the course and inputs of a share link. */
function applyShared(plan: SharedPlan): void {
  if (plan.course.kind === "drawn") {
    drawing.load(plan.course.route);
    if (appStore.get().sheet === "peek") setSheet("half");
  } else {
    loadCourseCopy(plan.course.points, plan.name ?? "Shared course", "link");
  }
  applyPlanSettings(settingsOf(plan));
}

/**
 * Open the share link in `fragment` (a URL's `#...`). Returns false when it is not a share link at
 * all; a link that cannot be read sets `linkError` and returns true.
 */
export function openShareFragment(fragment: string): boolean {
  if (!isShareFragment(fragment)) return false;
  try {
    applyShared(decodeShare(fragment));
  } catch (error) {
    if (!(error instanceof ShareError)) throw error;
    console.warn("Could not open the share link:", error.detail);
    setLinkError(error.message);
    // On a phone, bring the message up out of the sheet's peek.
    if (appStore.get().sheet === "peek") setSheet("half");
  }
  return true;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseSession(text: string | null): SavedSession | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<SavedSession> | null;
    if (!value || value.v !== SESSION_VERSION) return undefined;
    const goal = value.goalTimeS;
    if (!(goal === null || (isNumber(goal) && goal > 0))) return undefined;
    if (!isNumber(value.paceChanges) || !isNumber(value.minSegmentM) || value.minSegmentM < 0) return undefined;
    return {
      v: SESSION_VERSION,
      course: value.course ?? null,
      goalTimeS: goal,
      paceChanges: value.paceChanges,
      minSegmentM: value.minSegmentM,
    };
  } catch {
    return undefined;
  }
}

/** Bring back the saved session, if there is one. */
function restoreSaved(): void {
  const saved = parseSession(read(SESSION_STORAGE_KEY));
  if (!saved) return;
  const settings: PlanSettings = { ...saved, units: appStore.get().units };
  const course = saved.course;
  try {
    if (course?.kind === "file") {
      const text = read(SESSION_GPX_STORAGE_KEY);
      if (!text || typeof course.fileName !== "string") return;
      void loadGpxText(text, course.fileName, course.track).then((ok) => ok && applyPlanSettings(settings));
      return;
    }
    if (course?.kind === "drawn") {
      const shared = decodeSharedCourse(course.c);
      if (shared.kind !== "drawn") return;
      drawing.load(shared.route);
    } else if (course?.kind === "copy") {
      const shared = decodeSharedCourse(course.c);
      if (shared.kind !== "track") return;
      loadCourseCopy(shared.points, String(course.name), course.copy === "link" ? "link" : "saved");
    }
    applyPlanSettings(settings);
  } catch (error) {
    // A damaged session is dropped, never shown: the app starts as if there were none.
    if (!(error instanceof ShareError)) throw error;
    console.warn("Could not restore the last session:", error.detail);
  }
}

let opened = false;

/** A loaded file's text waiting to be written with the session. */
let pendingText: { text: string; file: GpxFile } | null = null;

/** Write a loaded file's text, if it is the course on screen. A file past the cap is never tried. */
function storePendingText(state: AppState): void {
  const pending = pendingText;
  if (!pending || state.course.status !== "loaded" || state.course.file !== pending.file) return;
  pendingText = null;
  const kept = pending.text.length <= MAX_STORED_GPX_CHARS && write(SESSION_GPX_STORAGE_KEY, pending.text);
  if (!kept) write(SESSION_GPX_STORAGE_KEY, null);
  storedFile = kept ? pending.file : null;
}

/** The file whose text is in storage, so the session can name it instead of keeping a copy. */
let storedFile: GpxFile | null = null;

function trackPoints(file: GpxFile, index: number): readonly LatLon[] {
  return file.tracks[index]?.course.points ?? [];
}

function savedCourse(state: AppState, route: DrawnRoute): SavedCourse | null | "skip" {
  const { course } = state;
  switch (course.status) {
    case "reading":
      return "skip";
    case "drawn":
      return route.waypoints.length >= 2 ? { kind: "drawn", c: encodeSharedCourse({ kind: "drawn", route }) } : null;
    case "loaded": {
      if (!course.copy && course.file === storedFile) {
        return { kind: "file", fileName: course.fileName, track: course.track };
      }
      const points = trackPoints(course.file, course.track);
      // A link's copy is already simplified; a file too large to keep is simplified now.
      const simplified = course.copy ? points : simplifyForShare(points, SAVED_COPY_MAX_CHARS)?.points;
      if (!simplified) return null;
      const name = course.copy ? course.fileName : trackTitle(course.file, course.track, course.fileName);
      return {
        kind: "copy",
        copy: course.copy ?? "saved",
        name,
        c: encodeSharedCourse({ kind: "track", points: simplified.map(({ lat, lon }) => ({ lat, lon })) }),
      };
    }
    default:
      return null;
  }
}

/** Write the session now. */
export function saveSession(): void {
  const state = appStore.get();
  storePendingText(state);
  const course = savedCourse(state, drawStore.get().history.present);
  if (course === "skip") return;
  if (course?.kind !== "file") {
    write(SESSION_GPX_STORAGE_KEY, null);
    storedFile = null;
  }
  const session: SavedSession = {
    v: SESSION_VERSION,
    course,
    goalTimeS: state.goalTimeS,
    paceChanges: state.paceChanges,
    minSegmentM: state.minSegmentM,
  };
  write(SESSION_STORAGE_KEY, JSON.stringify(session));
}

/**
 * Start the session: open the share link the page was opened with (else bring back the saved
 * session), then keep the session saved and listen for links pasted into the address bar.
 * Returns the function that stops it.
 */
export function startSession(): () => void {
  // The text is written with the session (debounced), off the load's critical path: a large
  // file's write is slow, and may only fail on quota.
  onGpxText((text, file) => {
    pendingText = { text, file };
  });

  const takeFragment = (): boolean => {
    const fragment = location.hash;
    if (!isShareFragment(fragment)) return false;
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    openShareFragment(fragment);
    return appStore.get().linkError === null;
  };
  // Once per page: React's development double effects must not restore over a link just opened.
  if (!opened) {
    opened = true;
    if (!takeFragment()) restoreSaved();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    saveSession();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };
  const unsubscribeApp = appStore.subscribe((state, previous) => {
    if (
      state.course !== previous.course ||
      state.goalTimeS !== previous.goalTimeS ||
      state.paceChanges !== previous.paceChanges ||
      state.minSegmentM !== previous.minSegmentM
    ) {
      schedule();
    }
  });
  const unsubscribeDraw = drawStore.subscribe((state, previous) => {
    if (state.history.present !== previous.history.present) schedule();
  });
  const onHide = () => {
    if (timer !== undefined) flush();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onHide();
  };
  const onHashChange = () => {
    takeFragment();
  };
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("hashchange", onHashChange);
  return () => {
    onHide();
    unsubscribeApp();
    unsubscribeDraw();
    onGpxText(undefined);
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("hashchange", onHashChange);
  };
}
