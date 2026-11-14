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

/**
 * Keep `<html>` in step with the theme: the `dark` class drives the color tokens and Tailwind's
 * `dark:` variant, and `color-scheme` styles native controls. `index.html` sets both before first paint.
 */
export function useApplyTheme(theme: Theme): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  }, [theme]);
}
