import type { ReactNode } from "react";
import { DESKTOP_QUERY, useMediaQuery } from "../layout/useMediaQuery.ts";
import { usePwaState } from "../pwa/pwa.ts";
import { HeaderMenu } from "./HeaderMenu.tsx";

export interface PanelHeaderProps {
  action?: ReactNode;
  /** Keep the status line short: on the phone header beside its buttons. */
  brief?: boolean;
}

/** The app's name and mark, at the top of the panel (and all that shows of the sheet at `peek`). */
export function PanelHeader({ action, brief = false }: PanelHeaderProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return (
    <header className="relative flex h-[72px] items-center gap-3 px-6">
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
        <StatusLine brief={brief} />
      </div>
      {action}
      {/* The phone header has no room left beside its buttons, so the menu sits in the sheet's top corner. */}
      {desktop ? (
        <HeaderMenu />
      ) : (
        <div className="absolute -top-[17px] right-3.5">
          <HeaderMenu corner />
        </div>
      )}
    </header>
  );
}

/**
 * Under the name: the tagline, or what the app needs you to know. Offline, it says so (and that
 * GPX files still work); after a newer build takes over, it offers a reload. A live region, so a
 * change is announced without moving focus.
 */
function StatusLine({ brief }: { brief: boolean }) {
  const online = usePwaState((s) => s.online);
  const updateReady = usePwaState((s) => s.updateReady);
  const state = !online ? "offline" : updateReady ? "update" : "idle";
  return (
    <p
      role="status"
      className="flex min-w-0 items-center gap-1.5 text-sm leading-snug text-ink-muted"
      data-testid="status-line"
      data-state={state}
    >
      {state === "offline" ? (
        <>
          <svg
            viewBox="0 0 24 24"
            className="size-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.69M19 12.86a10 10 0 0 0-2-1.52M2 8.82a15 15 0 0 1 4.18-2.64M22 8.82a15 15 0 0 0-11.29-3.76M2 2l20 20" />
          </svg>
          <span className="truncate">
            <span className="font-medium text-ink">Offline</span>
            {!brief && <span>: GPX files still work</span>}
          </span>
        </>
      ) : state === "update" ? (
        <>
          {/* Beside the phone header's buttons there is room for the button alone. */}
          {!brief && <span className="truncate">A new version is ready</span>}
          <button
            type="button"
            onClick={() => location.reload()}
            className={`-my-1.5 shrink-0 cursor-pointer rounded-md py-1.5 ${brief ? "-mx-1 px-1" : "px-1"} font-semibold text-accent underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none`}
            data-testid="reload-update"
          >
            {brief ? "Reload to update" : "Reload"}
          </button>
        </>
      ) : (
        <span className="truncate">Elevation-aware pacing plans</span>
      )}
    </p>
  );
}
