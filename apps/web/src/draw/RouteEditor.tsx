import { type DistanceUnit, type LegMode, isClosed } from "@pp/core";
import { DESKTOP_QUERY, useMediaQuery } from "../layout/useMediaQuery.ts";
import { formatDistance, quantityText } from "../panel/format.ts";
import { useAppState } from "../state/app.ts";
import { type LegView, drawing, useDrawState } from "../state/draw.ts";
import { SECONDARY_BUTTON } from "./DrawButton.tsx";
import { CHECK, Icon, LOOP, OUT_AND_BACK, PATHS, STRAIGHT } from "./icons.tsx";

/** What to do next, for the number of waypoints so far. */
function hint(waypoints: number, desktop: boolean): string {
  const click = desktop ? "Click" : "Tap";
  if (waypoints === 0)
    return `${click} the map where your course starts. Zoomed far out, a ${click.toLowerCase()} zooms in there first.`;
  if (waypoints === 1)
    return `${click} where it goes next. Each leg follows paths, or runs straight with Straight picked in the toolbar.`;
  return desktop
    ? "Drag a point to move it, or the dot in the middle of a leg to add one. Click a point to remove it."
    : "Drag a point to move it, or the dot in the middle of a leg to add one. Tap a point to remove it.";
}

/**
 * The panel while drawing: the live distance, what to do next, the Close loop and Out and back
 * shortcuts, and each leg with its mode (and its routing error, if any).
 */
export function RouteEditor() {
  const units = useAppState((s) => s.units);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const history = useDrawState((s) => s.history);
  const legs = useDrawState((s) => s.legs);
  const distanceM = useDrawState((s) => s.distanceM);
  const newLegMode = useDrawState((s) => s.newLegMode);
  const route = history.present;
  const count = route.waypoints.length;
  const routing = legs.some((leg) => leg.status === "pending");
  const distance = formatDistance(distanceM, units);

  return (
    <section aria-labelledby="draw-title" data-testid="route-editor">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-[0.08em] text-accent uppercase">Drawing</p>
          <h2 id="draw-title" className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-ink">
            Your route
          </h2>
        </div>
        <button
          type="button"
          onClick={drawing.finish}
          className={`${SECONDARY_BUTTON} mt-1`}
          data-testid="finish-drawing"
        >
          {count >= 2 && <Icon className="size-4">{CHECK}</Icon>}
          {count >= 2 ? "Done" : "Cancel"}
        </button>
      </div>

      <div className="mt-4 rounded-2xl bg-surface-raised px-4 py-3.5 ring-1 ring-line ring-inset">
        <div className="flex items-baseline justify-between gap-3">
          <p
            className="text-ink tabular-nums"
            data-testid="draw-distance"
            aria-label={`Distance ${quantityText(distance)}`}
          >
            <span className="text-[34px] leading-none font-semibold tracking-tight">{distance.value}</span>
            <span className="ml-1 text-lg font-medium text-ink-muted">{distance.unit}</span>
          </p>
          <p
            role="status"
            className="flex items-center gap-1.5 text-xs font-medium text-ink-muted"
            data-testid="draw-status"
            data-routing={routing || undefined}
          >
            {routing && (
              <>
                <span className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
                Routing
              </>
            )}
          </p>
        </div>
        <p className="mt-1.5 text-[13px] text-ink-muted" data-testid="draw-summary">
          {count} {count === 1 ? "point" : "points"}, {legs.length} {legs.length === 1 ? "leg" : "legs"}
        </p>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-pretty text-ink-muted" data-testid="draw-hint">
        {hint(count, desktop)}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={count < 2 || isClosed(route)}
          onClick={() => drawing.dispatch({ type: "closeLoop", mode: newLegMode })}
          className={SECONDARY_BUTTON}
        >
          <Icon className="size-4">{LOOP}</Icon>
          Close loop
        </button>
        <button
          type="button"
          disabled={count < 2}
          onClick={() => drawing.dispatch({ type: "outAndBack" })}
          className={SECONDARY_BUTTON}
        >
          <Icon className="size-4">{OUT_AND_BACK}</Icon>
          Out and back
        </button>
      </div>

      {legs.length > 0 && (
        <ol aria-label="Legs" className="mt-5 divide-y divide-line rounded-2xl ring-1 ring-line ring-inset">
          {legs.map((leg) => (
            <LegRow key={leg.index} leg={leg} units={units} />
          ))}
        </ol>
      )}
    </section>
  );
}

const MODE_OPTIONS: { value: LegMode; label: string; icon: typeof PATHS }[] = [
  { value: "snap", label: "Follow paths", icon: PATHS },
  { value: "straight", label: "Straight line", icon: STRAIGHT },
];

function LegRow({ leg, units }: { leg: LegView; units: DistanceUnit }) {
  const name = `Leg ${leg.index + 1}`;
  return (
    <li className="px-3.5 py-2.5" data-testid="draw-leg" data-status={leg.status} data-mode={leg.mode}>
      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 text-[13px] font-medium text-ink">{name}</span>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] tabular-nums ${leg.status === "error" ? "font-medium text-danger" : "text-ink-muted"}`}
        >
          {leg.status === "ready"
            ? quantityText(formatDistance(leg.distanceM, units))
            : leg.status === "pending"
              ? "Routing..."
              : "Couldn't follow paths"}
        </span>
        <fieldset className="shrink-0">
          <legend className="sr-only">{name} mode</legend>
          <div className="flex rounded-lg bg-surface-raised p-0.5 ring-1 ring-line ring-inset">
            {MODE_OPTIONS.map(({ value, label, icon }) => (
              <label
                key={value}
                title={label}
                className="grid size-9 cursor-pointer place-items-center rounded-md text-ink-muted transition-colors hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-accent"
              >
                <input
                  type="radio"
                  name={`leg-${leg.index}-mode`}
                  value={value}
                  aria-label={label}
                  checked={leg.mode === value}
                  onChange={() => drawing.dispatch({ type: "setMode", leg: leg.index, mode: value })}
                  className="sr-only"
                />
                <Icon className="size-4">{icon}</Icon>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {leg.status === "error" && (
        <div className="mt-2 rounded-xl bg-danger-soft px-3 py-2.5">
          <p className="text-[13px] leading-snug text-ink">{leg.error?.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => drawing.dispatch({ type: "setMode", leg: leg.index, mode: "straight" })}
              className={SECONDARY_BUTTON}
            >
              Use a straight line
            </button>
            <button type="button" onClick={() => drawing.retryLeg(leg.index)} className={SECONDARY_BUTTON}>
              Try again
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
