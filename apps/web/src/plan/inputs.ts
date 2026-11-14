/**
 * The plan inputs as the user types and picks them: reading and checking a goal time, the goal
 * suggested before they enter one, and the shortest-segment choices for each unit system.
 * Pure functions, unit tested apart from the DOM.
 */
import { type DistanceUnit, METERS_PER_MILE, formatDuration, formatPace, parseDuration } from "@pp/core";

/** The suggested goal before the user enters one: a steady 9:00 per mile effort. */
export const SUGGESTED_PACE_S_PER_MI = 9 * 60;
/** No goal pace may be quicker than 3:00 per mile (1:52 per km), about a minute faster than any record. */
export const FASTEST_PACE_S_PER_MI = 3 * 60;
/** Nor slower than an hour per mile, which is no longer a pace anyone plans. */
export const SLOWEST_PACE_S_PER_MI = 60 * 60;

/** The goal suggested for a course `lengthM` long: rounded to 5 minutes from an hour up, else to the minute. */
export function suggestedGoalS(lengthM: number): number {
  const raw = (lengthM / METERS_PER_MILE) * SUGGESTED_PACE_S_PER_MI;
  const step = raw >= 3600 ? 300 : 60;
  return Math.max(step, Math.round(raw / step) * step);
}

export type GoalCheck = { ok: true; seconds: number } | { ok: false; message: string };

/**
 * Read a goal time typed for a course `lengthM` long. Accepts `h:mm:ss` and `m:ss` (as
 * `parseDuration` does). Rejects anything else, and goals whose average pace no one would plan,
 * with a message that says what to type instead. A short time that reads better as hours and
 * minutes (`3:30` for a marathon) gets that suggestion.
 */
export function checkGoal(text: string, lengthM: number, unit: DistanceUnit): GoalCheck {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "Enter a goal time, like 3:30:00." };
  const seconds = parseDuration(trimmed);
  if (seconds === undefined) {
    return { ok: false, message: "Use hours, minutes and seconds, like 3:30:00 (or 25:00 under an hour)." };
  }
  const paceSPerMi = (seconds / lengthM) * METERS_PER_MILE;
  if (seconds === 0 || paceSPerMi < FASTEST_PACE_S_PER_MI) {
    const asHours = /^\d+:[0-5]\d$/.test(trimmed) ? seconds * 60 : undefined;
    const plausible =
      asHours !== undefined && (asHours / lengthM) * METERS_PER_MILE >= FASTEST_PACE_S_PER_MI
        ? ` Did you mean ${formatDuration(asHours)}?`
        : "";
    const pace = seconds === 0 ? "no time at all" : `${formatPace(seconds / lengthM, unit)} per ${unit}`;
    return { ok: false, message: `That is ${pace}, faster than anyone runs.${plausible}` };
  }
  if (paceSPerMi > SLOWEST_PACE_S_PER_MI) {
    const longest = Math.floor((SLOWEST_PACE_S_PER_MI * lengthM) / METERS_PER_MILE);
    const slowest = formatPace(SLOWEST_PACE_S_PER_MI / METERS_PER_MILE, unit);
    return {
      ok: false,
      message: `That is slower than ${slowest} per ${unit}. Enter a goal up to ${formatDuration(longest)}.`,
    };
  }
  return { ok: true, seconds };
}

/** One choice for the shortest segment. */
export interface MinSegmentOption {
  /** Meters; 0 means no minimum. */
  meters: number;
  label: string;
}

const MIN_SEGMENT_CHOICES: Record<DistanceUnit, number[]> = {
  mi: [0, 0.1, 0.25, 0.5, 1],
  km: [0, 0.2, 0.5, 1, 2],
};

/** The shortest-segment choices in a unit system, smallest first. */
export function minSegmentOptions(unit: DistanceUnit): MinSegmentOption[] {
  const perUnit = unit === "mi" ? METERS_PER_MILE : 1000;
  return MIN_SEGMENT_CHOICES[unit].map((d) => ({
    meters: d * perUnit,
    label: d === 0 ? "No minimum" : `${d} ${unit}`,
  }));
}

/** The default shortest segment: a quarter mile, or half a kilometer. */
export function defaultMinSegmentM(unit: DistanceUnit): number {
  return unit === "mi" ? 0.25 * METERS_PER_MILE : 500;
}

/** The choice in `unit` nearest `meters` (on a log scale, so 0.25 mi becomes 0.5 km), keeping 0 as 0. */
export function snapMinSegmentM(meters: number, unit: DistanceUnit): number {
  const options = minSegmentOptions(unit);
  if (!(meters > 0)) return 0;
  let best = options[1]!.meters;
  for (const { meters: m } of options.slice(1)) {
    if (Math.abs(Math.log(m / meters)) < Math.abs(Math.log(best / meters))) best = m;
  }
  return best;
}

/**
 * Round each of `values` to a whole number so the rounded values add up to the rounded total
 * (largest remainder first). The segment times in the table then add up to the finish time shown
 * under them, instead of drifting a second or two from rounding each one alone.
 */
export function roundPreservingSum(values: readonly number[]): number[] {
  const total = Math.round(values.reduce((a, b) => a + b, 0));
  const floors = values.map(Math.floor);
  let missing = total - floors.reduce((a, b) => a + b, 0);
  const order = values.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  const out = [...floors];
  for (const { i } of order) {
    if (missing <= 0) break;
    out[i] = (out[i] as number) + 1;
    missing--;
  }
  return out;
}
