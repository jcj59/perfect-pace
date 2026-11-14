import type { ReactNode } from "react";
import { type ThemePreference, setThemePreference, useAppState } from "../state/app.ts";

const OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: "system",
    label: "Auto",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
      </>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
      </>
    ),
  },
  { value: "dark", label: "Dark", icon: <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" /> },
];

/** Light, dark, or follow the system. */
export function ThemeSwitch() {
  const theme = useAppState((s) => s.theme);
  return (
    <fieldset className="flex items-center justify-between gap-4">
      <legend className="float-left text-sm font-medium text-ink-muted">Appearance</legend>
      <div className="flex rounded-full bg-surface-raised p-1 ring-1 ring-line ring-inset">
        {OPTIONS.map(({ value, label, icon }) => (
          <label
            key={value}
            className="relative flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-muted transition-colors select-none hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => setThemePreference(value)}
              className="sr-only"
            />
            <svg
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {icon}
            </svg>
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
