import type { DistanceUnit, ElevationProfile, GpxFile } from "@pp/core";
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
 * The course from a GPX file, from the moment the user picks one. `error` keeps the typed error's
 * `code` (a `GpxErrorCode`, when the parser rejected the file) and its user-facing message.
 */
export type CourseState =
  | { status: "empty" }
  | { status: "reading"; fileName: string }
  | { status: "error"; fileName: string; code?: string; message: string }
  | { status: "loaded"; fileName: string; file: GpxFile; track: number; elevation: ElevationState };

/**
 * App-wide UI state. Later units add the plan here; derived values (the resolved theme, the plan
 * for the current inputs) stay out of it.
 */
export interface AppState {
  theme: ThemePreference;
  /** Where the phone bottom sheet rests. Ignored by the desktop side panel. */
  sheet: SheetSnap;
  /** Distance unit for every number shown: miles with feet, or kilometers with meters. */
  units: DistanceUnit;
  course: CourseState;
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
  return {
    theme: readThemePreference(storage),
    sheet: "peek",
    units: readUnits(storage, language),
    course: { status: "empty" },
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

export function setUnits(units: DistanceUnit): void {
  appStore.set({ units });
  try {
    browserStorage()?.setItem(UNITS_STORAGE_KEY, units);
  } catch {
    // As for the theme: the choice still applies for this visit.
  }
}

/** Replace the course state. The load flow in `course.ts` is the only caller. */
export function setCourse(course: CourseState): void {
  appStore.set({ course });
}
