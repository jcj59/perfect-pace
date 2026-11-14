import { createStore, useStore } from "./store.ts";

/** The user's theme choice. `system` follows `prefers-color-scheme`. */
export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** Bottom sheet snap points on phones, smallest first. */
export const SHEET_SNAPS = ["peek", "half", "full"] as const;
export type SheetSnap = (typeof SHEET_SNAPS)[number];

/**
 * App-wide UI state. Later units add the course, profile and plan here; derived values (the
 * resolved theme, the plan for the current inputs) stay out of it.
 */
export interface AppState {
  theme: ThemePreference;
  /** Where the phone bottom sheet rests. Ignored by the desktop side panel. */
  sheet: SheetSnap;
}

export const THEME_STORAGE_KEY = "pp:theme";

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

export function initialAppState(storage?: Pick<Storage, "getItem">): AppState {
  return { theme: readThemePreference(storage), sheet: "peek" };
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export const appStore = createStore<AppState>(initialAppState(browserStorage()));

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
