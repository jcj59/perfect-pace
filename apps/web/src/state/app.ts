import {
  type Course,
  DEFAULT_CURVE_MAX_PACE_CHANGES,
  type DistanceUnit,
  type ElevationProfile,
  type GpxFile,
} from "@pp/core";
import { defaultMinSegmentM, snapMinSegmentM } from "../plan/inputs.ts";
import { createStore, useStore } from "./store.ts";

/** The user's theme choice. `system` follows `prefers-color-scheme`. */
export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** Bottom sheet snap points on phones, smallest first. */
export const SHEET_SNAPS = ["peek", "half", "full"] as const;
export type SheetSnap = (typeof SHEET_SNAPS)[number];

/** The elevation profile of the selected track, built in the core worker after the file parses. */
export type ElevationState =
  { status: "loading" } | { status: "ready"; profile: ElevationProfile } | { status: "error"; message: string };

/**
 * The course: from a GPX file, from the moment the user picks one, or drawn on the map. `error`
 * keeps the typed error's `code` (a `GpxErrorCode`, when the parser rejected the file) and its
 * user-facing message.
 *
 * A `drawn` course (see `state/draw.ts`) has a `course` once the route has two waypoints and every
 * leg has its line, and then an elevation profile from the DEM. While an edit is being routed or
 * its profile built, `updating` is set and the last profile stays in `elevation`.
 */
export type CourseState =
  | { status: "empty" }
  | { status: "reading"; fileName: string }
  | { status: "error"; fileName: string; code?: string; message: string }
  | {
      status: "loaded";
      fileName: string;
      file: GpxFile;
      track: number;
      elevation: ElevationState;
      /**
       * Set for a simplified copy rather than the file itself: from a share link, or `saved` on
       * this device in place of a file too large to keep. Its elevation comes from terrain data.
       */
      copy?: "link" | "saved";
    }
  | { status: "drawn"; course: Course | null; elevation: ElevationState | null; updating: boolean };

/** The pace changes a plan starts with, before the user moves the slider. */
export const DEFAULT_PACE_CHANGES = 4;

/**
 * App-wide UI state, including the plan inputs. Derived values (the resolved theme, the plan for
 * the current inputs, which `plan.ts` computes in the worker) stay out of it.
 */
export interface AppState {
  theme: ThemePreference;
  /** Where the phone bottom sheet rests. Ignored by the desktop side panel. */
  sheet: SheetSnap;
  /** Distance unit for every number shown: miles with feet, or kilometers with meters. */
  units: DistanceUnit;
  course: CourseState;
  /**
   * The point along the course (meters from the start) the user is pointing at: hovering or
   * scrubbing the elevation chart, the arrow keys on it, or hovering the route on the map. The
   * map draws its marker there and the chart its cursor. Null when nothing is pointed at.
   */
  focusDistM: number | null;
  /**
   * The goal finish time the user entered, in seconds, or null before they enter one (the plan
   * then uses `suggestedGoalS` for the course). A new course clears it.
   */
  goalTimeS: number | null;
  /** The most pace changes the plan may use (the slider), 0 to `DEFAULT_CURVE_MAX_PACE_CHANGES`. */
  paceChanges: number;
  /** Every plan segment is at least this long, meters (one of `minSegmentOptions(units)`). */
  minSegmentM: number;
  /** The plan segment picked in the table, highlighted on the map and the chart, or null. */
  selectedSegment: number | null;
  /** Why the share link the page was opened with could not be used, until dismissed or a course loads. */
  linkError: string | null;
}

export const THEME_STORAGE_KEY = "pp:theme";
export const UNITS_STORAGE_KEY = "pp:units";

/** Regions that measure road distance in miles. Everyone else gets kilometers by default. */
const MILE_REGIONS = new Set(["US", "GB", "LR", "MM"]);

/** The distance unit for a BCP 47 language tag (`en-US` is miles, `de-DE` kilometers). */
export function defaultUnits(language: string | undefined): DistanceUnit {
  let region: string | undefined;
  try {
    region = language ? new Intl.Locale(language).maximize().region : undefined;
  } catch {
    region = undefined;
  }
  return region && MILE_REGIONS.has(region) ? "mi" : "km";
}

/** The stored unit choice, or the language's default when none is stored. */
export function readUnits(storage: Pick<Storage, "getItem"> | undefined, language: string | undefined): DistanceUnit {
  try {
    const value = storage?.getItem(UNITS_STORAGE_KEY);
    if (value === "mi" || value === "km") return value;
  } catch {
    // Fall through to the default.
  }
  return defaultUnits(language);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** The stored theme choice, or `system` when none is stored (or storage is unavailable). */
export function readThemePreference(storage: Pick<Storage, "getItem"> | undefined): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function initialAppState(storage?: Pick<Storage, "getItem">, language?: string): AppState {
  const units = readUnits(storage, language);
  return {
    theme: readThemePreference(storage),
    sheet: "peek",
    units,
    course: { status: "empty" },
    focusDistM: null,
    goalTimeS: null,
    paceChanges: DEFAULT_PACE_CHANGES,
    minSegmentM: defaultMinSegmentM(units),
    selectedSegment: null,
    linkError: null,
  };
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export const appStore = createStore<AppState>(initialAppState(browserStorage(), globalThis.navigator?.language));

export function useAppState<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}

export function setThemePreference(theme: ThemePreference): void {
  appStore.set({ theme });
  try {
    if (theme === "system") browserStorage()?.removeItem(THEME_STORAGE_KEY);
    else browserStorage()?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be full or blocked; the choice still applies for this visit.
  }
}

export function setSheet(sheet: SheetSnap): void {
  appStore.set({ sheet });
}

/** Switch units. The shortest segment moves to the nearest choice in the new units, so the menu always shows it. */
export function setUnits(units: DistanceUnit): void {
  appStore.set((s) => ({ units, minSegmentM: snapMinSegmentM(s.minSegmentM, units) }));
  try {
    browserStorage()?.setItem(UNITS_STORAGE_KEY, units);
  } catch {
    // As for the theme: the choice still applies for this visit.
  }
}

/**
 * Replace the course state. The load flow in `course.ts` and the drawing flow in `draw.ts` are the
 * only callers. `fresh` marks a different course (a new file, another track or a new drawing),
 * which also drops the goal entered for the last; edits to a drawn route keep it.
 */
export function setCourse(course: CourseState, fresh = false): void {
  appStore.set({
    course,
    focusDistM: null,
    selectedSegment: null,
    ...(fresh ? { goalTimeS: null, ...(course.status !== "empty" ? { linkError: null } : {}) } : {}),
  });
}

/** The plan inputs, as a share link or the saved session carries them. */
export interface PlanSettings {
  goalTimeS: number | null;
  paceChanges: number;
  minSegmentM: number;
  units: DistanceUnit;
}

/**
 * Apply plan inputs from a link or the saved session, after the course they are for. Values out
 * of range are brought in (the shortest segment to the nearest choice in the units). Units from a
 * link apply to this visit only: the stored preference is the person's own.
 */
export function applyPlanSettings(settings: PlanSettings): void {
  appStore.set({
    units: settings.units,
    goalTimeS: settings.goalTimeS,
    paceChanges: Math.max(0, Math.min(DEFAULT_CURVE_MAX_PACE_CHANGES, Math.round(settings.paceChanges))),
    minSegmentM: snapMinSegmentM(settings.minSegmentM, settings.units),
  });
}

export function setLinkError(linkError: string | null): void {
  appStore.set({ linkError });
}

/** Set the goal finish time in seconds (a checked one: see `checkGoal`). */
export function setGoalTimeS(goalTimeS: number): void {
  appStore.set({ goalTimeS });
}

export function setPaceChanges(paceChanges: number): void {
  appStore.set({ paceChanges });
}

export function setMinSegmentM(minSegmentM: number): void {
  appStore.set({ minSegmentM });
}

/** Pick a plan segment to highlight on the map and chart, or clear the pick with null. */
export function setSelectedSegment(selectedSegment: number | null): void {
  appStore.set({ selectedSegment });
}

/** Point at a distance along the course (meters), or clear the pointer with null. */
export function setFocusDistM(focusDistM: number | null): void {
  appStore.set({ focusDistM });
}
