import {
  type DistanceUnit,
  type ElevationProfile,
  MAX_CUSTOM_BREAKPOINTS,
  METERS_PER_KM,
  METERS_PER_MILE,
  type Plan,
  type PlanType,
  formatPace,
  metersToUnit,
  paceToUnit,
} from "@pp/core";
import { type KeyboardEvent, useId, useState } from "react";
import { Icon } from "../draw/icons.tsx";
import { checkSplit, distanceInput, nextBreakpointM, parseDistance, retypedBreakpoints } from "../plan/breakpoints.ts";
import { setBreakpointsM, setPlanType, setSplitM, useAppState } from "../state/app.ts";
import { Segmented } from "./Segmented.tsx";

const PLAN_TYPE_OPTIONS: { value: PlanType; label: string; ariaLabel?: string }[] = [
  { value: "optimal", label: "Optimal" },
  { value: "even", label: "Even", ariaLabel: "Even pace" },
  { value: "splits", label: "Splits" },
  { value: "custom", label: "Custom" },
];

/** How the plan is shaped: Optimal, Even pace, Splits or Custom, above the plan's inputs. */
export function PlanTypePicker() {
  const planType = useAppState((s) => s.planType);
  return (
    <Segmented
      legend="Plan type"
      options={PLAN_TYPE_OPTIONS}
      value={planType}
      onChange={setPlanType}
      fill
      testId="plan-type"
    />
  );
}

/** The plan's average gap from the ideal pace, rounded to the second, in the units. */
function paceGap(plan: Plan, units: DistanceUnit): number {
  return Math.round(paceToUnit(Math.sqrt(plan.error / plan.lengthM), units));
}

/** The plan in view, when it is the plan type on screen (so a note never describes the type before). */
function usePlanOf(plan: Plan | null, type: PlanType): Plan | null {
  return plan?.type === type ? plan : null;
}

/** How closely a fixed plan follows the ideal pace, the same measure the Optimal curve shows. */
function GapNote({ plan, units, lead }: { plan: Plan | null; units: DistanceUnit; lead: string }) {
  return (
    <p className="text-[13px] leading-snug text-ink-muted" data-testid="plan-type-note">
      {lead}
      {plan && ` On average ${paceGap(plan, units)} s/${units} off the ideal pace for every hill.`}
    </p>
  );
}

/** Even pace: nothing to set, so a line on what it means. */
export function EvenControls({ plan, units }: { plan: Plan | null; units: DistanceUnit }) {
  const even = usePlanOf(plan, "even");
  const pace = even?.segments[0] ? `${formatPace(even.segments[0].paceSPerM, units)} /${units}` : "your goal pace";
  return <GapNote plan={even} units={units} lead={`One pace for the whole course: ${pace}, up and down every hill.`} />;
}

type SplitChoice = "mi" | "km" | "custom";

const SPLIT_PRESETS: Record<Exclude<SplitChoice, "custom">, number> = { mi: METERS_PER_MILE, km: METERS_PER_KM };

/** The split length that comes up when the user picks Custom: 5 of the units. */
const DEFAULT_CUSTOM_SPLITS = 5;

/** Splits: one segment per split of 1 mi, 1 km or a typed distance; the last split is the remainder. */
export function SplitControls({ plan, units, lengthM }: { plan: Plan | null; units: DistanceUnit; lengthM: number }) {
  const splitM = useAppState((s) => s.splitM);
  const preset = splitM === METERS_PER_MILE ? "mi" : splitM === METERS_PER_KM ? "km" : null;
  const [customOpen, setCustomOpen] = useState(preset === null);
  const choice: SplitChoice = customOpen || preset === null ? "custom" : preset;
  const [text, setText] = useState(() => (preset ? String(DEFAULT_CUSTOM_SPLITS) : distanceInput(splitM, units)));
  const [message, setMessage] = useState<string | null>(null);
  const inputId = useId();
  const noteId = useId();
  const splits = usePlanOf(plan, "splits");

  const pick = (next: SplitChoice) => {
    if (next === "custom") {
      setCustomOpen(true);
      const check = checkSplit(text, units, lengthM);
      if (check.ok) setSplitM(check.meters);
      return;
    }
    setCustomOpen(false);
    setMessage(null);
    setSplitM(SPLIT_PRESETS[next]);
  };
  const onChange = (value: string) => {
    setText(value);
    const check = checkSplit(value, units, lengthM);
    if (check.ok) {
      setMessage(null);
      setSplitM(check.meters);
    }
  };
  const settle = () => {
    const check = checkSplit(text, units, lengthM);
    if (check.ok) {
      setMessage(null);
      setSplitM(check.meters);
    } else setMessage(check.message);
  };

  const count = splits?.segments.length;
  const last = splits?.segments.at(-1);
  const remainder =
    splits && last && count && count > 1 && Math.abs(last.lengthM - splits.splitM) > 1
      ? ` The last is the ${metersToUnit(last.lengthM, units).toFixed(2)} ${units} left.`
      : "";
  const lead = count ? `${count} ${count === 1 ? "split" : "splits"}, each at its own pace.${remainder}` : "";

  return (
    <div className="space-y-3">
      <Segmented
        legend="Split length"
        showLegend
        options={[
          { value: "mi", label: "1 mi", ariaLabel: "1 mile" },
          { value: "km", label: "1 km", ariaLabel: "1 kilometer" },
          { value: "custom", label: "Custom" },
        ]}
        value={choice}
        onChange={pick}
        testId="split-length"
      />
      {choice === "custom" && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={inputId} className="text-sm text-ink-muted">
              Split every
            </label>
            <span className="flex items-center gap-2">
              <input
                id={inputId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={text}
                aria-invalid={message !== null}
                aria-describedby={noteId}
                onChange={(e) => onChange(e.target.value)}
                onBlur={settle}
                onKeyDown={(e) => e.key === "Enter" && settle()}
                className="h-9 w-20 rounded-lg bg-surface px-3 text-right text-sm font-semibold text-ink tabular-nums ring-1 ring-line ring-inset hover:ring-ink-subtle/50 focus:ring-2 focus:ring-accent focus:outline-none aria-invalid:ring-2 aria-invalid:ring-danger"
                data-testid="split-custom"
              />
              <span className="w-5 text-sm text-ink-muted">{units}</span>
            </span>
          </div>
          {message && (
            <p id={noteId} role="alert" className="mt-2 text-[13px] leading-snug text-danger" data-testid="split-error">
              {message}
            </p>
          )}
        </div>
      )}
      <GapNote plan={splits} units={units} lead={lead} />
    </div>
  );
}

/**
 * Custom: the user's own breakpoints. Placed by clicking or tapping the elevation profile and
 * dragged there to move (see `ElevationChart`), or typed and removed in this list; each sits on a
 * course point. Every field and button works by keyboard.
 */
export function CustomControls({
  profile,
  plan,
  units,
}: {
  profile: ElevationProfile;
  plan: Plan | null;
  units: DistanceUnit;
}) {
  const breakpointsM = useAppState((s) => s.breakpointsM);
  const custom = usePlanOf(plan, "custom");
  const course = profile.course;
  const lengthM = course.points.at(-1)?.distM ?? 0;
  const next = nextBreakpointM(course, breakpointsM);
  const full = breakpointsM.length >= MAX_CUSTOM_BREAKPOINTS;
  const hintId = useId();
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const verb = coarse ? "Tap" : "Click";

  const add = () => {
    if (next !== undefined) setBreakpointsM([...breakpointsM, next]);
  };

  return (
    <div data-testid="custom-breakpoints">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-ink">Breakpoints</p>
        <span className="text-sm text-ink-muted tabular-nums" data-testid="breakpoint-count">
          <span className="font-semibold text-ink">{breakpointsM.length}</span>
          <span className="mx-1.5 text-ink-subtle">/</span>
          {breakpointsM.length + 1} {breakpointsM.length === 0 ? "segment" : "segments"}
        </span>
      </div>
      <p
        id={hintId}
        className="mt-1.5 flex gap-2 text-[13px] leading-snug text-ink-muted"
        data-testid="breakpoint-hint"
      >
        <svg
          viewBox="0 0 24 24"
          className="mt-px size-4 shrink-0 text-ink-subtle"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5" />
        </svg>
        <span>
          {verb} the elevation profile to add a breakpoint where the pace changes, and drag one to move it. Or type a
          distance below.
        </span>
      </p>
      {breakpointsM.length > 0 && (
        <ol className="mt-3 space-y-1.5" aria-label="Breakpoints">
          {breakpointsM.map((m, i) => (
            <BreakpointRow
              key={i}
              index={i}
              meters={m}
              units={units}
              lengthM={lengthM}
              onCommit={(distM) => {
                const out = retypedBreakpoints(course, breakpointsM, i, distM);
                if (out) setBreakpointsM(out);
                return out !== undefined;
              }}
              onRemove={() => setBreakpointsM(breakpointsM.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={add}
          disabled={next === undefined}
          aria-describedby={hintId}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-surface px-3 text-sm font-medium text-ink ring-1 ring-line ring-inset transition-colors hover:ring-ink-subtle/50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="add-breakpoint"
        >
          <Icon className="size-4">
            <path d="M12 5v14M5 12h14" />
          </Icon>
          Add breakpoint
        </button>
        {breakpointsM.length > 0 && (
          <button
            type="button"
            onClick={() => setBreakpointsM([])}
            className="h-9 cursor-pointer rounded-lg px-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            data-testid="clear-breakpoints"
          >
            Clear all
          </button>
        )}
      </div>
      {full && (
        <p className="mt-2 text-[13px] leading-snug text-ink-muted" data-testid="breakpoints-full">
          {MAX_CUSTOM_BREAKPOINTS} breakpoints is the most a plan can have.
        </p>
      )}
      {custom && breakpointsM.length > 0 && (
        <div className="mt-3">
          <GapNote plan={custom} units={units} lead="" />
        </div>
      )}
    </div>
  );
}

/** One breakpoint: its number, its distance to edit, and a button that removes it. */
function BreakpointRow({
  index,
  meters,
  units,
  lengthM,
  onCommit,
  onRemove,
}: {
  index: number;
  meters: number;
  units: DistanceUnit;
  lengthM: number;
  /** Put the breakpoint at a typed distance; false when it cannot go there. */
  onCommit: (distM: number) => boolean;
  onRemove: () => void;
}) {
  const shown = distanceInput(meters, units);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const id = useId();
  if (!editing && text !== shown && message === null) setText(shown);
  const max = metersToUnit(lengthM, units).toFixed(2);

  const settle = () => {
    const distM = parseDistance(text, units);
    if (distM !== undefined && distM > 0 && distM < lengthM && onCommit(distM)) {
      setMessage(null);
      setText(distanceInput(distM, units));
      return;
    }
    setMessage(`Enter a distance between 0 and ${max} ${units}.`);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") settle();
    if (event.key === "Escape") {
      setText(shown);
      setMessage(null);
    }
  };

  return (
    <li data-testid="breakpoint-row">
      <div className="flex items-center gap-2">
        <span
          className="grid size-6 shrink-0 place-items-center rounded-full bg-surface text-[11px] font-semibold text-ink-muted tabular-nums ring-1 ring-line ring-inset"
          aria-hidden="true"
        >
          {index + 1}
        </span>
        <label htmlFor={id} className="sr-only">
          Breakpoint {index + 1}, {units} from the start
        </label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          aria-invalid={message !== null}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            settle();
          }}
          onKeyDown={onKeyDown}
          className="h-9 w-24 rounded-lg bg-surface px-3 text-right text-sm font-semibold text-ink tabular-nums ring-1 ring-line ring-inset hover:ring-ink-subtle/50 focus:ring-2 focus:ring-accent focus:outline-none aria-invalid:ring-2 aria-invalid:ring-danger"
          data-testid="breakpoint-input"
        />
        <span className="text-sm text-ink-muted">{units}</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove breakpoint ${index + 1} at ${shown} ${units}`}
          className="relative ml-auto inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-subtle transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-line/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="remove-breakpoint"
        >
          <Icon className="size-4">
            <path d="M6 6l12 12M18 6 6 18" />
          </Icon>
        </button>
      </div>
      {message && (
        <p role="alert" className="mt-1 pl-8 text-[13px] leading-snug text-danger" data-testid="breakpoint-error">
          {message}
        </p>
      )}
    </li>
  );
}
