import { type LegMode, canRedo, canUndo } from "@pp/core";
import type { ReactNode } from "react";
import { usePwaState } from "../pwa/pwa.ts";
import { drawing, useDrawState } from "../state/draw.ts";
import { CLEAR, Icon, PATHS, REDO, RETRY, STRAIGHT, UNDO } from "./icons.tsx";

const MODES: { value: LegMode; label: string; icon: ReactNode; title: string }[] = [
  { value: "snap", label: "Paths", icon: PATHS, title: "New legs follow paths" },
  { value: "straight", label: "Straight", icon: STRAIGHT, title: "New legs are straight lines" },
];

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-11 cursor-pointer place-items-center rounded-xl text-ink transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:text-ink-subtle/50 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/**
 * The drawing controls over the map: undo, redo, the mode for new legs, and clear. Beside them, a
 * leg that could not follow paths shows its error with a straight line on offer, without stopping
 * the drawing.
 */
export function DrawToolbar({ placement }: { placement: "top" | "bottom" }) {
  const history = useDrawState((s) => s.history);
  const newLegMode = useDrawState((s) => s.newLegMode);
  const legs = useDrawState((s) => s.legs);
  const failed = legs.find((leg) => leg.status === "error");
  const empty = history.present.waypoints.length === 0;
  const online = usePwaState((s) => s.online);

  return (
    // Under the map's top edge the error hangs below the toolbar; over the phone sheet it sits
    // above it, so the toolbar stays put under the thumb.
    <div
      className={`pointer-events-none flex max-w-full gap-2 ${placement === "top" ? "flex-col items-start" : "flex-col-reverse items-center"}`}
      data-testid="draw-toolbar"
    >
      <div
        role="toolbar"
        aria-label="Drawing"
        className="pointer-events-auto flex items-center gap-0.5 rounded-2xl border border-line bg-surface p-1 shadow-panel"
      >
        <ToolButton label="Undo" disabled={!canUndo(history)} onClick={() => drawing.dispatch({ type: "undo" })}>
          <Icon>{UNDO}</Icon>
        </ToolButton>
        <ToolButton label="Redo" disabled={!canRedo(history)} onClick={() => drawing.dispatch({ type: "redo" })}>
          <Icon>{REDO}</Icon>
        </ToolButton>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <fieldset className="flex">
          <legend className="sr-only">New legs</legend>
          <div className="flex rounded-xl bg-surface-raised p-0.5 ring-1 ring-line ring-inset">
            {MODES.map(({ value, label, icon, title }) => (
              <label
                key={value}
                title={title}
                className="flex h-10 cursor-pointer items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-semibold text-ink-muted transition-colors select-none hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
              >
                <input
                  type="radio"
                  name="leg-mode"
                  value={value}
                  aria-label={title}
                  checked={newLegMode === value}
                  onChange={() => drawing.setNewLegMode(value)}
                  className="sr-only"
                />
                <Icon className="size-4">{icon}</Icon>
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <ToolButton label="Clear the route" disabled={empty} onClick={() => drawing.dispatch({ type: "clear" })}>
          <Icon>{CLEAR}</Icon>
        </ToolButton>
      </div>
      {!online && (
        <div
          role="status"
          data-testid="draw-offline"
          className="pointer-events-auto w-[22rem] max-w-full rounded-2xl border border-line bg-surface p-3.5 shadow-panel"
        >
          <p className="text-[13px] leading-snug font-semibold text-ink">You're offline</p>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
            Drawing needs an internet connection: new legs can't follow paths until you reconnect.
          </p>
        </div>
      )}
      {failed && (
        <div
          role="alert"
          data-testid="routing-error"
          className="pointer-events-auto w-[22rem] max-w-full rounded-2xl border border-danger/25 bg-surface p-3.5 shadow-panel"
        >
          <p className="text-[13px] leading-snug font-semibold text-ink">
            Leg {failed.index + 1} couldn't follow paths
          </p>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">{failed.error?.message}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => drawing.dispatch({ type: "setMode", leg: failed.index, mode: "straight" })}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-semibold text-on-accent hover:brightness-105 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none"
            >
              <Icon className="size-4">{STRAIGHT}</Icon>
              Use a straight line
            </button>
            <button
              type="button"
              onClick={() => drawing.retryLeg(failed.index)}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-surface-raised px-3 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-line/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Icon className="size-4">{RETRY}</Icon>
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
