import {
  DEFAULT_CURVE_MAX_PACE_CHANGES,
  type DistanceUnit,
  type ElevationProfile,
  type ErrorCurvePoint,
  METERS_PER_MILE,
  type Plan,
  formatDuration,
  formatPace,
  metersToUnit,
  paceToUnit,
} from "@pp/core";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useWidth } from "../layout/useWidth.ts";
import { curveKnee, curvePoints } from "../plan/curve.ts";
import { SUGGESTED_PACE_S_PER_MI, checkGoal, minSegmentOptions, roundPreservingSum } from "../plan/inputs.ts";
import { TONES, type Tone, segmentTone, toneLabel, toneVar } from "../plan/tones.ts";
import { setGoalTimeS, setMinSegmentM, setPaceChanges, setSelectedSegment, useAppState } from "../state/app.ts";
import {
  PLAN_RECOMPUTE_MEASURE,
  PLAN_RENDERED_MARK,
  PLAN_REQUEST_MARK,
  effectiveGoalS,
  usePlanView,
} from "../state/plan.ts";

/** The slider thumb's diameter in CSS pixels (`.pp-range` in styles.css): the curve's points sit at its center. */
const RANGE_THUMB_PX = 22;
const CURVE_HEIGHT_PX = 64;
/** Room above the curve for the label over the selected point. */
const CURVE_TOP_PX = 18;

/**
 * The pacing plan for the loaded course: the inputs (goal time, pace changes with the error
 * curve, shortest segment), the predicted finish, the segment table, and the pace model it
 * assumes. Pace changes and the shortest segment recompute the plan in the worker as they
 * change (see `state/plan.ts`); the plan in view stays up, marked as updating, until the new one lands.
 */
export function PacingPlan({ profile, headingLevel }: { profile: ElevationProfile; headingLevel: 2 | 3 }) {
  const units = useAppState((s) => s.units);
  const view = usePlanView((v) => v);
  const plan = view.profile === profile ? view.plan : null;
  const error = view.profile === profile ? view.error : null;
  const lengthM = profile.course.points.at(-1)?.distM ?? 0;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section aria-labelledby="plan-heading" data-testid="pacing-plan">
      <div className="flex items-center justify-between gap-3">
        <Heading id="plan-heading" className="text-xs font-semibold tracking-[0.08em] text-ink-subtle uppercase">
          Pacing plan
        </Heading>
        <span
          role="status"
          className="pp-pending flex items-center gap-1.5 text-xs font-medium text-ink-muted"
          data-pending={view.pending || undefined}
          data-testid="plan-pending"
        >
          {view.pending && (
            <>
              <span className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
              Updating
            </>
          )}
        </span>
      </div>

      <div className="mt-3 space-y-5 rounded-2xl bg-surface-raised px-4 py-4 ring-1 ring-line ring-inset">
        <GoalRow profile={profile} lengthM={lengthM} units={units} plan={plan} />
        <PaceChanges plan={plan} units={units} />
        <MinSegment units={units} />
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] leading-snug text-ink"
          data-testid="plan-error"
        >
          {error}
        </p>
      ) : plan ? (
        <div
          className="mt-5 transition-opacity duration-150 data-pending:opacity-60 data-pending:delay-200 motion-reduce:transition-none"
          data-pending={view.pending || undefined}
          aria-busy={view.pending}
        >
          <SegmentTable plan={plan} units={units} />
          <ToneLegend plan={plan} units={units} />
          <Assumption plan={plan} units={units} />
        </div>
      ) : (
        <div className="mt-5 space-y-2" aria-busy="true" data-testid="plan-placeholder">
          <span className="sr-only">Working out the plan...</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-raised motion-reduce:animate-none" />
          ))}
        </div>
      )}
    </section>
  );
}

/** The goal time (editable) beside the plan's predicted finish. */
function GoalRow({
  profile,
  lengthM,
  units,
  plan,
}: {
  profile: ElevationProfile;
  lengthM: number;
  units: DistanceUnit;
  plan: Plan | null;
}) {
  const goalTimeS = useAppState((s) => s.goalTimeS);
  const goal = effectiveGoalS({ goalTimeS }, profile);
  const inputId = useId();
  const noteId = useId();
  const [text, setText] = useState(() => formatDuration(goal));
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shown, setShown] = useState(goal);

  // A new course (or its suggestion) replaces the text, unless the user is typing in it.
  if (goal !== shown) {
    setShown(goal);
    if (!editing) {
      setText(formatDuration(goal));
      setMessage(null);
    }
  }

  const onChange = (value: string) => {
    setText(value);
    const check = checkGoal(value, lengthM, units);
    if (check.ok) {
      setMessage(null);
      setGoalTimeS(check.seconds);
    }
  };
  const settle = () => {
    const check = checkGoal(text, lengthM, units);
    if (check.ok) {
      setMessage(null);
      setText(formatDuration(check.seconds));
      setGoalTimeS(check.seconds);
    } else setMessage(check.message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") settle();
  };

  const predicted = plan ? formatDuration(plan.totalTimeS) : null;
  const onGoal = plan ? Math.abs(plan.totalTimeS - plan.goalTimeS) < 1 : false;
  const suggestion = formatPace(SUGGESTED_PACE_S_PER_MI / METERS_PER_MILE, units);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={inputId} className="block text-sm font-medium text-ink">
            Goal time
          </label>
          <input
            id={inputId}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="h:mm:ss"
            value={text}
            aria-invalid={message !== null}
            aria-describedby={noteId}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              settle();
            }}
            onKeyDown={onKeyDown}
            className="mt-1.5 h-11 w-full rounded-xl bg-surface px-3 text-xl font-semibold tracking-tight text-ink tabular-nums ring-1 ring-line ring-inset placeholder:text-ink-subtle placeholder:font-normal hover:ring-ink-subtle/50 focus:ring-2 focus:ring-accent focus:outline-none aria-invalid:ring-2 aria-invalid:ring-danger"
            data-testid="goal-input"
          />
        </div>
        <div>
          <p className="text-sm font-medium text-ink-muted">Predicted finish</p>
          <p className="mt-1.5 flex h-11 items-center gap-1.5" data-testid="plan-predicted">
            {predicted ? (
              <>
                <span className="text-xl font-semibold tracking-tight text-ink tabular-nums">{predicted}</span>
                {onGoal && (
                  <span className="text-accent" title="Matches your goal">
                    <svg
                      viewBox="0 0 24 24"
                      className="size-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                    <span className="sr-only">matches your goal</span>
                  </span>
                )}
              </>
            ) : (
              <span className="block h-5 w-24 animate-pulse rounded bg-line motion-reduce:animate-none">
                <span className="sr-only">Working it out</span>
              </span>
            )}
          </p>
        </div>
      </div>
      <p
        id={noteId}
        className={`mt-2 text-[13px] leading-snug ${message ? "text-danger" : "text-ink-muted"}`}
        data-testid={message ? "goal-error" : "goal-note"}
        {...(message ? { role: "alert" } : {})}
      >
        {message ? (
          <>
            {message}
            {plan && (
              <span className="text-ink-muted"> The plan below is still for {formatDuration(plan.goalTimeS)}.</span>
            )}
          </>
        ) : goalTimeS === null ? (
          `A suggestion for a ${suggestion} /${units} effort. Enter your own goal.`
        ) : (
          "The segments below add up to this goal, to the second."
        )}
      </p>
    </div>
  );
}

/** The pace-change slider, with the error curve that shows what each extra change buys. */
function PaceChanges({ plan, units }: { plan: Plan | null; units: DistanceUnit }) {
  const paceChanges = useAppState((s) => s.paceChanges);
  const minSegmentM = useAppState((s) => s.minSegmentM);
  const id = useId();
  const captionId = useId();
  const max = DEFAULT_CURVE_MAX_PACE_CHANGES;
  const curve = plan?.errorCurve;
  const point = curve?.[paceChanges];
  const segments = plan && plan.paceChanges === paceChanges ? plan.segments.length : paceChanges + 1;
  const gap = point ? Math.round(paceToUnit(point.rmsPaceGapSPerM, units)) : undefined;
  const knee = curve ? curveKnee(curve) : undefined;
  const fits = point && point.segments < paceChanges + 1 ? point.segments : undefined;
  const minLabel = minSegmentOptions(units).find((o) => o.meters === minSegmentM)?.label;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          Pace changes
        </label>
        <span className="text-sm text-ink-muted tabular-nums" data-testid="pace-changes-value">
          <span className="font-semibold text-ink">{paceChanges}</span>
          <span className="mx-1.5 text-ink-subtle">/</span>
          {segments} {segments === 1 ? "segment" : "segments"}
        </span>
      </div>
      <ErrorCurve curve={curve} selected={paceChanges} units={units} />
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={1}
        value={paceChanges}
        onChange={(e) => setPaceChanges(Number(e.target.value))}
        aria-describedby={captionId}
        aria-valuetext={`${paceChanges} pace ${paceChanges === 1 ? "change" : "changes"}, ${segments} ${segments === 1 ? "segment" : "segments"}`}
        className="pp-range"
        style={{ "--pp-range-fill": `${(paceChanges / max) * 100}%` } as CSSProperties}
        data-testid="pace-changes"
      />
      <div className="mt-1 flex justify-between text-[11px] text-ink-subtle" aria-hidden="true">
        <span>One steady pace</span>
        <span>{max} changes</span>
      </div>
      <p id={captionId} className="mt-2 text-[13px] leading-snug text-ink-muted" data-testid="curve-caption">
        {gap === undefined || knee === undefined ? (
          "The curve shows how closely each number of changes can follow the ideal pace."
        ) : (
          <>
            On average {gap} s/{units} off the ideal pace for every hill.{" "}
            {knee === 0
              ? "This course is flat enough that one steady pace is all it needs."
              : `Most of the gain comes by ${knee} ${knee === 1 ? "change" : "changes"}; after that each one helps less.`}
            {fits !== undefined && minLabel && ` Only ${fits} segments fit with a ${minLabel} minimum.`}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The error vs number of pace changes curve: the plan's average gap from the ideal pace for 0 to
 * 10 changes, with each point over the slider's matching stop. Decorative to assistive technology;
 * the caption under the slider says the same in words.
 */
function ErrorCurve({
  curve,
  selected,
  units,
}: {
  curve: readonly ErrorCurvePoint[] | undefined;
  selected: number;
  units: DistanceUnit;
}) {
  const [root, width] = useWidth<HTMLDivElement>();
  const points = useMemo(
    () => (curve && width > 0 ? curvePoints(curve, width, CURVE_HEIGHT_PX - 4, RANGE_THUMB_PX / 2, CURVE_TOP_PX) : []),
    [curve, width],
  );
  const line = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
  const first = points[0];
  const last = points.at(-1);
  const area =
    first && last ? `${line}L${last.x.toFixed(1)} ${CURVE_HEIGHT_PX}L${first.x.toFixed(1)} ${CURVE_HEIGHT_PX}Z` : "";
  const at = points[selected];
  const gap = curve?.[selected] ? Math.round(paceToUnit(curve[selected].rmsPaceGapSPerM, units)) : undefined;
  const label = gap === undefined ? "" : `${gap} s/${units}`;
  const labelHalf = label.length * 3.2;
  const labelX = at ? Math.min(Math.max(at.x, labelHalf), width - labelHalf) : 0;

  return (
    <div ref={root} className="mt-2" style={{ height: CURVE_HEIGHT_PX }} aria-hidden="true" data-testid="error-curve">
      {points.length > 0 && (
        <svg width={width} height={CURVE_HEIGHT_PX} className="block overflow-visible">
          <path d={area} fill="var(--pp-accent)" fillOpacity={0.1} />
          <path d={line} fill="none" stroke="var(--pp-accent)" strokeWidth={2} strokeLinejoin="round" />
          {points.map((p) => (
            <circle
              key={p.paceChanges}
              cx={p.x}
              cy={p.y}
              r={p.paceChanges === selected ? 5.5 : 2.5}
              fill={p.paceChanges === selected ? "var(--pp-accent)" : "var(--pp-surface-raised)"}
              stroke={p.paceChanges === selected ? "var(--pp-surface-raised)" : "var(--pp-accent)"}
              strokeWidth={p.paceChanges === selected ? 2.5 : 1.5}
              data-selected={p.paceChanges === selected || undefined}
            />
          ))}
          {at && (
            <text
              x={labelX}
              y={at.y - 10}
              textAnchor="middle"
              className="fill-ink-muted text-[11px] font-semibold tabular-nums"
            >
              {label}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}

function MinSegment({ units }: { units: DistanceUnit }) {
  const minSegmentM = useAppState((s) => s.minSegmentM);
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        Shortest segment
      </label>
      <span className="relative">
        <select
          id={id}
          value={minSegmentM}
          onChange={(e) => setMinSegmentM(Number(e.target.value))}
          className="h-9 cursor-pointer appearance-none rounded-lg bg-surface pr-8 pl-3 text-sm font-medium text-ink ring-1 ring-line ring-inset hover:ring-ink-subtle/50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          data-testid="min-segment"
        >
          {minSegmentOptions(units).map((o) => (
            <option key={o.meters} value={o.meters}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-subtle"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m7 10 5 5 5-5" />
        </svg>
      </span>
    </div>
  );
}

const distanceFormats = new Map<number, Intl.NumberFormat>();
function distanceText(meters: number, units: DistanceUnit, decimals: number): string {
  let format = distanceFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    distanceFormats.set(decimals, format);
  }
  return format.format(metersToUnit(meters, units));
}

/** A grade as a signed percentage, `+1.2%`, `-0.4%` or `0.0%`. */
function gradeText(grade: number): string {
  const pct = (grade * 100).toFixed(1);
  if (Number(pct) === 0) return "0.0%";
  return grade > 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * One row per segment: where it runs, the pace to hold, its average grade and its time, with the
 * reason under it. The times are rounded so they add up to the predicted finish in the last row.
 * Picking a row highlights its segment on the map and the chart; picking it again clears that.
 */
function SegmentTable({ plan, units }: { plan: Plan; units: DistanceUnit }) {
  const selected = useAppState((s) => s.selectedSegment);
  const decimals = metersToUnit(plan.lengthM, units) < 3 ? 2 : 1;
  const times = roundPreservingSum(plan.segments.map((s) => s.timeS));
  const total = times.reduce((a, b) => a + b, 0);

  // The recompute is done once the new plan is on screen.
  useLayoutEffect(() => {
    if (performance.getEntriesByName(PLAN_REQUEST_MARK, "mark").length === 0) return;
    performance.clearMarks(PLAN_RENDERED_MARK);
    performance.clearMeasures(PLAN_RECOMPUTE_MEASURE);
    performance.mark(PLAN_RENDERED_MARK);
    performance.measure(PLAN_RECOMPUTE_MEASURE, PLAN_REQUEST_MARK, PLAN_RENDERED_MARK);
  }, [plan]);

  return (
    <table
      className="w-full table-fixed border-separate border-spacing-0 text-sm tabular-nums"
      data-testid="segment-table"
    >
      <caption className="sr-only">
        Pace for each segment of the course. Select a segment to highlight it on the map and the elevation profile.
      </caption>
      <colgroup>
        <col />
        <col className="w-[58px]" />
        <col className="w-[58px]" />
        <col className="w-[72px]" />
      </colgroup>
      <thead>
        <tr className="text-left text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap text-ink-subtle uppercase">
          <th scope="col" className="pb-2 pl-3 font-semibold">
            Segment ({units})
          </th>
          <th scope="col" className="pb-2 text-right font-semibold">
            Pace /{units}
          </th>
          <th scope="col" className="pb-2 text-right font-semibold">
            Grade
          </th>
          <th scope="col" className="pr-3 pb-2 text-right font-semibold">
            Time
          </th>
        </tr>
      </thead>
      {/* One body per segment: its numbers, then its reason across the full width. */}
      {plan.segments.map((segment, i) => {
        const tone = segmentTone(segment.paceSPerM, plan.flatPaceSPerM);
        const isSelected = selected === i;
        const range = `${distanceText(segment.startM, units, decimals)}\u2013${distanceText(segment.endM, units, decimals)}`;
        const fill = `transition-colors ${isSelected ? "bg-accent-soft" : "group-hover:bg-surface-raised"}`;
        const cell = `${fill} border-t border-line pt-2.5 align-baseline`;
        return (
          <tbody
            key={i}
            className="group cursor-pointer"
            onClick={() => setSelectedSegment(isSelected ? null : i)}
            data-testid="segment-row"
            data-selected={isSelected || undefined}
            data-tone={tone}
          >
            <tr>
              <td className={`${cell} rounded-tl-xl pl-3`}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`Segment ${i + 1}, ${range} ${units}: ${formatPace(segment.paceSPerM, units)} per ${units}, ${toneLabel(tone)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedSegment(isSelected ? null : i);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-md text-left font-semibold whitespace-nowrap text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span
                    className={`h-3.5 shrink-0 rounded-full transition-[width] ${isSelected ? "w-2" : "w-1.5"}`}
                    style={{ background: toneVar(tone) }}
                    aria-hidden="true"
                  />
                  {range}
                </button>
              </td>
              <td className={`${cell} text-right font-semibold text-ink`} data-testid="segment-pace">
                {formatPace(segment.paceSPerM, units)}
              </td>
              <td className={`${cell} text-right text-ink-muted`}>{gradeText(segment.avgGrade)}</td>
              <td className={`${cell} rounded-tr-xl pr-3 text-right text-ink`} data-testid="segment-time">
                {formatDuration(times[i] ?? 0)}
              </td>
            </tr>
            <tr>
              <td colSpan={4} className={`${fill} rounded-b-xl pr-3 pb-2.5 pl-6.5 text-xs leading-snug text-ink-muted`}>
                {segment.reason}
              </td>
            </tr>
          </tbody>
        );
      })}
      <tfoot>
        <tr className="font-semibold text-ink">
          <th scope="row" className="border-t-2 border-line pt-2.5 pl-3 text-left">
            Finish
          </th>
          <td className="border-t-2 border-line pt-2.5 text-right">
            {formatPace(plan.goalTimeS / plan.lengthM, units)}
          </td>
          <td className="border-t-2 border-line pt-2.5" />
          <td className="border-t-2 border-line pt-2.5 pr-3 text-right" data-testid="plan-total">
            {formatDuration(total)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/** What the segment colors mean, as a diverging scale around the goal's flat pace. */
function ToneLegend({ plan, units }: { plan: Plan; units: DistanceUnit }) {
  const used = new Set(plan.segments.map((s) => segmentTone(s.paceSPerM, plan.flatPaceSPerM)));
  return (
    <div className="mt-4 flex items-center gap-2 text-xs text-ink-muted" data-testid="tone-legend">
      <span>Faster</span>
      <span className="flex gap-0.5" aria-hidden="true">
        {TONES.map((tone: Tone) => (
          <span
            key={tone}
            className={`h-2.5 w-4 first:rounded-l-full last:rounded-r-full ${used.has(tone) ? "" : "opacity-35"}`}
            style={{ background: toneVar(tone) }}
          />
        ))}
      </span>
      <span>Slower</span>
      <span className="ml-auto text-right">
        than {formatPace(plan.flatPaceSPerM, units)} /{units} flat pace
      </span>
    </div>
  );
}

/** The pace model's stated assumption, which every number above rests on. */
function Assumption({ plan, units }: { plan: Plan; units: DistanceUnit }) {
  return (
    <InfoNote testId="plan-assumption">
      <span className="font-medium text-ink">How the plan works. </span>
      {plan.model.assumption} For your goal that makes flat ground {formatPace(plan.flatPaceSPerM, units)} /{units}. The
      plan holds each segment at the average of that ideal, hill-by-hill pace, so the segments add up to your goal.
    </InfoNote>
  );
}

function InfoNote({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p className="mt-4 flex gap-2 text-[13px] leading-snug text-ink-muted" data-testid={testId}>
      <svg
        viewBox="0 0 24 24"
        className="mt-px size-4 shrink-0 text-ink-subtle"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
