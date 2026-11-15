import { useEffect } from "react";
import { useMediaQuery } from "./layout/useMediaQuery.ts";
import { type Theme, type ThemePreference, useAppState } from "./state/app.ts";

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** The theme in effect: the user's choice, or the system's when they chose `system`. */
export function useTheme(): Theme {
  const preference = useAppState((s) => s.theme);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  return resolveTheme(preference, systemDark);
}

/** The browser chrome's color for each theme (the map's background, `--pp-map`). */
export const THEME_COLORS: Record<Theme, string> = { light: "#f3f1ec", dark: "#1a1918" };

/**
 * Keep `<html>` in step with the theme: the `dark` class drives the color tokens and Tailwind's
 * `dark:` variant, `color-scheme` styles native controls, and the `theme-color` metas tint the
 * browser and installed app's chrome (theirs follow the system; a picked theme overrides it).
 * `index.html` sets them before first paint.
 */
export function useApplyTheme(theme: Theme): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = THEME_COLORS[theme];
    }
  }, [theme]);
}
