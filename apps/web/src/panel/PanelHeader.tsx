import type { ReactNode } from "react";

/** The app's name and mark, at the top of the panel (and all that shows of the sheet at `peek`). */
export function PanelHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="flex h-[72px] items-center gap-3 px-6">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <svg
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 18 6 16.5l4-7.5 3.5 4 3-5.5 5 6.5" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-[17px] leading-tight font-semibold tracking-tight whitespace-nowrap text-ink">
          Perfect Pace
        </h1>
        <p className="truncate text-sm leading-snug text-ink-muted">Elevation-aware pacing plans</p>
      </div>
      {action}
    </header>
  );
}
