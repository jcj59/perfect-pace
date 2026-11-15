/**
 * The pacing plan: `computePlan(course, inputs)` runs the pace model over the course's grades,
 * cuts the course into pieces by the plan type, and describes each piece in words.
 *
 * Pipeline, all in meters and seconds:
 *
 * 1. Interval lengths `w_i` and grades come from the course's points (normally the smoothed,
 *    resampled course of `buildElevationProfile`).
 * 2. The pace model gives the ideal pace `o_i = (b + g_i) * m_i` of every interval: the base pace
 *    `b` plus the grade adjustment `g_i`, times the product `m_i` of the pace factors' multipliers
 *    (weather, surface, altitude; `pace-factors.ts`), with `b` solved so that `sum_i w_i o_i` is
 *    the goal time. Time-dependent factors are resolved by iterating on the arrival times
 *    (`solvePlan` below).
 * 3. The plan type picks the pieces. `optimal` (the default): `segmentLeastSquares` picks at most
 *    `paceChanges + 1` contiguous pieces minimizing `sum_i w_i (p_i - o_i)^2`, each at least
 *    `minSegmentM` long. The others are fixed partitions, paced by `planForPartition`: `even` is
 *    one piece, `splits` a piece every `splitM` (the last is the remainder), and `custom` the
 *    user's breakpoints. Either way each piece's pace is its length-weighted mean ideal pace, which
 *    makes the plan's total time equal the goal (see the `segmenter.ts` module doc for why that is
 *    automatic for any partition).
 * 4. Each piece gets its average grade, gain and loss, a terrain label and a short reason.
 *
 * Every plan type shares steps 1, 2 and 4 (`solvePlan`, `idealPaces` and `describeSegments`
 * below), so they are directly comparable, and a change to the ideal pace (a new factor included)
 * applies to all of them at once. Step 3 only ever sees the ideal paces.
 */
import { type Course, type CoursePoint, courseBearingsDeg, courseLengthM } from "./course.ts";
import { DEFAULT_GAIN_THRESHOLD_M, MAX_ABS_GRADE, computeGrades, gainLoss } from "./elevation.ts";
import {
  DEFAULT_PACE_FACTORS,
  FACTOR_ARRIVAL_TOLERANCE_S,
  MAX_FACTOR_ROUNDS,
  type PaceFactor,
  type PaceFactorContext,
  type PaceFactorEffect,
  type PaceFactorSummary,
} from "./pace-factors.ts";
import { type PaceModel, danielsPaceModel } from "./pace-model.ts";
import { type Segmentation, segmentLeastSquares, segmentPartition } from "./segmenter.ts";
import { type DistanceUnit, metersPerUnit, metersToUnit } from "./units.ts";

/** How the plan cuts the course into constant-pace segments. */
export const PLAN_TYPES = ["optimal", "even", "splits", "custom"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** The most segments a fixed partition may have (a split every 100 m of a 100 km race). */
export const MAX_PARTITION_SEGMENTS = 1000;

/** The most breakpoints a custom plan may have. */
export const MAX_CUSTOM_BREAKPOINTS = 40;

/** Inputs to `computePlan`. */
export interface PlanInputs {
  /** Goal finish time in seconds. */
  goalTimeS: number;
  /** The most pace changes allowed, so the plan has at most `paceChanges + 1` segments. */
  paceChanges: number;
  /** Display units for the reasons (distances in mi or km, elevation in ft or m). */
  unit: DistanceUnit;
  /** Every segment is at least this long, in meters (default 0, no minimum). */
  minSegmentM?: number;
  /**
   * The error curve covers 0 to this many pace changes. Default
   * `max(paceChanges, DEFAULT_CURVE_MAX_PACE_CHANGES)`, so the curve stays put while a slider
   * moves within it. It is raised to `paceChanges` when lower.
   */
  curveMaxPaceChanges?: number;
  /** The ideal pace model. Default `danielsPaceModel`. */
  model?: PaceModel;
  /**
   * The race-day conditions applied to the ideal pace, each with a unique `id`. Default
   * `DEFAULT_PACE_FACTORS` (all neutral); `[]` applies none.
   */
  factors?: readonly PaceFactor[];
  /**
   * How the course is cut into segments (default `optimal`). `paceChanges`, `minSegmentM` and
   * `curveMaxPaceChanges` apply to `optimal` only, `splitM` to `splits` and `breakpointsM` to
   * `custom`.
   */
  type?: PlanType;
  /** For `splits`: the split length in meters (default one `unit`). The last split is the remainder. */
  splitM?: number;
  /**
   * For `custom`: where the pace changes, meters from the start, in any order. Each is moved to
   * the nearest course point (`snapToCourse`); ones that land on the start, the finish or each
   * other are dropped.
   */
  breakpointsM?: readonly number[];
}

/** The error curve's default extent: 0 to 10 pace changes. */
export const DEFAULT_CURVE_MAX_PACE_CHANGES = 10;

/** A segment at least this steep on average (1%) is a climb or a descent. */
export const CLIMB_GRADE = 0.01;
/** Gentler than a climb but at least this steep on average (0.3%) is a gentle climb or descent. */
export const GENTLE_GRADE = 0.003;
/**
 * A segment with no clear net grade but this much up and down per meter (gain plus loss over
 * length, 1.5%) is rolling.
 */
export const ROLLING_RELIEF = 0.015;

/** What a segment's terrain is like, in decreasing order of precedence. */
export type Terrain = "climb" | "descent" | "rolling" | "gentle climb" | "gentle descent" | "flat";

/** One constant-pace segment of a plan. */
export interface PlanSegment {
  /** First course point of the segment (an index into `course.points`). */
  startIndex: number;
  /** Last course point of the segment; the next segment starts here. */
  endIndex: number;
  startM: number;
  endM: number;
  lengthM: number;
  /** The pace to hold, seconds per meter. */
  paceSPerM: number;
  /** Time on this segment at `paceSPerM`, seconds. */
  timeS: number;
  /** Net rise over length (0.05 is 5%). */
  avgGrade: number;
  /** Climbing and descending within the segment, meters (same hysteresis as the course stats). */
  gainM: number;
  lossM: number;
  terrain: Terrain;
  /** A short explanation, for example `climb: +3.8% over 0.6 mi`. */
  reason: string;
}

/** One point of the error vs number of pace changes curve. */
export interface ErrorCurvePoint {
  /** The most pace changes allowed. */
  paceChanges: number;
  /** Segments the optimal plan actually uses (fewer when more do not help or fit). */
  segments: number;
  /** The minimized `sum_i w_i (p_i - o_i)^2`, in s^2/m. */
  error: number;
  /**
   * The same error as a pace: the length-weighted root mean square gap between plan and ideal
   * pace, `sqrt(error / length)`, in seconds per meter. Easier to show than `error`.
   */
  rmsPaceGapSPerM: number;
}

/** A pacing plan for one course and one set of inputs. */
export interface Plan {
  type: PlanType;
  goalTimeS: number;
  /** The plan's predicted finish time, `sum` of segment times. Equals the goal within rounding. */
  totalTimeS: number;
  lengthM: number;
  unit: DistanceUnit;
  /**
   * The pace changes asked for; `segments.length - 1` may be fewer. For a fixed partition, the
   * changes it has.
   */
  paceChanges: number;
  /** The shortest segment asked for (0 for a fixed partition, which has none). */
  minSegmentM: number;
  /** For `splits`, the split length used, meters; 0 otherwise. */
  splitM: number;
  /** The plan's `sum_i w_i (p_i - o_i)^2` against the ideal pace, in s^2/m. */
  error: number;
  model: { id: string; assumption: string };
  /** The goal's pace on flat ground, seconds per meter. */
  flatPaceSPerM: number;
  segments: PlanSegment[];
  /** Optimal error for every allowed number of pace changes, from 0 up (empty for a fixed partition). */
  errorCurve: ErrorCurvePoint[];
  /** The model's ideal pace of every course interval `i..i + 1`, seconds per meter. */
  idealPacesSPerM: number[];
  /** How the pace factors were applied, and what each one costs. */
  paceFactors: PaceFactorSummary;
}

const METERS_PER_FOOT = 0.3048;

function assertInputs(course: Course, inputs: PlanInputs): void {
  const { goalTimeS, paceChanges, minSegmentM = 0, curveMaxPaceChanges } = inputs;
  if (course.points.length < 2) throw new RangeError("computePlan: the course needs at least two points");
  course.points.forEach((p, i) => {
    if (p.ele === undefined) throw new RangeError(`computePlan: point ${i} has no elevation`);
  });
  if (!(courseLengthM(course) > 0)) throw new RangeError("computePlan: the course has zero length");
  if (!(Number.isFinite(goalTimeS) && goalTimeS > 0)) {
    throw new RangeError(`computePlan: the goal must be a positive number of seconds, got ${goalTimeS}`);
  }
  if (!(Number.isInteger(paceChanges) && paceChanges >= 0)) {
    throw new RangeError(`computePlan: paceChanges must be a non-negative integer, got ${paceChanges}`);
  }
  if (!(Number.isFinite(minSegmentM) && minSegmentM >= 0)) {
    throw new RangeError(`computePlan: invalid minSegmentM ${minSegmentM}`);
  }
  if (curveMaxPaceChanges !== undefined && !(Number.isInteger(curveMaxPaceChanges) && curveMaxPaceChanges >= 0)) {
    throw new RangeError(`computePlan: curveMaxPaceChanges must be a non-negative integer, got ${curveMaxPaceChanges}`);
  }
  const { type = "optimal", splitM, breakpointsM } = inputs;
  if (!PLAN_TYPES.includes(type)) throw new RangeError(`computePlan: unknown plan type ${String(type)}`);
  if (splitM !== undefined && !(Number.isFinite(splitM) && splitM > 0)) {
    throw new RangeError(`computePlan: splitM must be a positive number of meters, got ${splitM}`);
  }
  if (breakpointsM?.some((b) => !Number.isFinite(b))) {
    throw new RangeError("computePlan: every breakpoint must be a finite distance");
  }
  const ids = new Set<string>();
  for (const f of inputs.factors ?? []) {
    if (ids.has(f.id)) throw new RangeError(`computePlan: two pace factors share the id ${f.id}`);
    ids.add(f.id);
  }
}

/** A distance for a reason: one decimal, or two under a tenth of a unit. */
function formatDistance(meters: number, unit: DistanceUnit): string {
  const d = metersToUnit(meters, unit);
  return `${d.toFixed(d < 0.095 ? 2 : 1)} ${unit}`;
}

/** A grade as a signed percentage with one decimal, `+3.8%`, `-0.4%` or `0.0%`. */
function formatGrade(grade: number): string {
  const pct = (grade * 100).toFixed(1);
  if (Number(pct) === 0) return "0.0%";
  return grade > 0 ? `+${pct}%` : `${pct}%`;
}

/** Elevation in feet (for miles) or meters (for kilometers), rounded to whole units. */
function formatElevation(meters: number, unit: DistanceUnit): string {
  return unit === "mi" ? `${Math.round(meters / METERS_PER_FOOT)} ft` : `${Math.round(meters)} m`;
}

/** The terrain label for a segment's average grade and relief. */
export function classifyTerrain(avgGrade: number, gainM: number, lossM: number, lengthM: number): Terrain {
  if (avgGrade >= CLIMB_GRADE) return "climb";
  if (avgGrade <= -CLIMB_GRADE) return "descent";
  if (lengthM > 0 && (gainM + lossM) / lengthM >= ROLLING_RELIEF) return "rolling";
  if (avgGrade >= GENTLE_GRADE) return "gentle climb";
  if (avgGrade <= -GENTLE_GRADE) return "gentle descent";
  return "flat";
}

/**
 * A segment's reason: `climb: +3.8% over 0.6 mi`, or for rolling terrain the up and down,
 * `rolling: +131 ft / -125 ft over 2.0 mi`.
 */
export function segmentReason(
  terrain: Terrain,
  avgGrade: number,
  gainM: number,
  lossM: number,
  lengthM: number,
  unit: DistanceUnit,
): string {
  const over = `over ${formatDistance(lengthM, unit)}`;
  if (terrain === "rolling") {
    return `rolling: +${formatElevation(gainM, unit)} / -${formatElevation(lossM, unit)} ${over}`;
  }
  return `${terrain}: ${formatGrade(avgGrade)} ${over}`;
}

/** The ideal pace of every course interval, with what describing the plan needs. */
interface IdealPaces {
  lengths: Float64Array;
  paces: Float64Array;
  flatPaceSPerM: number;
  eleM: number[];
}

/** Step 1: the course's points as the arrays the pace model and the factors read. */
interface CourseIntervals {
  distM: number[];
  eleM: number[];
  lengths: Float64Array;
  grades: number[];
}

function courseIntervals(course: Course): CourseIntervals {
  const points = course.points;
  const distM = points.map((p) => p.distM);
  const eleM = points.map((p) => p.ele as number);
  const n = points.length - 1;
  const lengths = new Float64Array(n);
  for (let i = 0; i < n; i++) lengths[i] = (distM[i + 1] as number) - (distM[i] as number);
  const grades = computeGrades(distM, eleM, MAX_ABS_GRADE);
  return { distM, eleM, lengths, grades };
}

/** Step 2 for given multipliers: the model's ideal paces, scaled to the goal. */
function idealPaces(c: CourseIntervals, goalTimeS: number, model: PaceModel, multipliers?: Float64Array): IdealPaces {
  const { paces, flatPaceSPerM } = model.idealPaces(c.lengths, c.grades, goalTimeS, multipliers);
  return { lengths: c.lengths, paces, flatPaceSPerM, eleM: c.eleM };
}

/** Seconds after the start the runner reaches each point, holding `paces` on the intervals. */
function arrivalsFromPaces(lengths: Float64Array, paces: ArrayLike<number>): Float64Array {
  const out = new Float64Array(lengths.length + 1);
  for (let i = 0; i < lengths.length; i++)
    out[i + 1] = (out[i] as number) + (lengths[i] as number) * (paces[i] as number);
  return out;
}

/** Seconds after the start the runner reaches each point following the plan's pieces. */
function arrivalsFromPlan(lengths: Float64Array, chosen: Segmentation): Float64Array {
  const out = new Float64Array(lengths.length + 1);
  for (let p = 0; p + 1 < chosen.bounds.length; p++) {
    const pace = chosen.values[p] as number;
    for (let i = chosen.bounds[p] as number; i < (chosen.bounds[p + 1] as number); i++) {
      out[i + 1] = (out[i] as number) + (lengths[i] as number) * pace;
    }
  }
  return out;
}

/** A factor's multipliers for `ctx`, checked: one positive finite number per interval. */
function sampleFactor(factor: PaceFactor, ctx: PaceFactorContext): Float64Array {
  const raw = factor.multipliers(ctx);
  const n = ctx.lengthsM.length;
  if (raw.length !== n) {
    throw new RangeError(`computePlan: pace factor ${factor.id} gave ${raw.length} multipliers for ${n} intervals`);
  }
  const out = Float64Array.from(raw);
  for (let i = 0; i < n; i++) {
    const m = out[i] as number;
    if (!(Number.isFinite(m) && m > 0)) {
      throw new RangeError(`computePlan: pace factor ${factor.id} gave invalid multiplier ${m} at interval ${i}`);
    }
  }
  return out;
}

/** The elementwise product of `arrays` (all of length `n`), or all ones when there are none. */
function product(arrays: readonly Float64Array[], n: number): Float64Array {
  const out = new Float64Array(n).fill(1);
  for (const a of arrays) for (let i = 0; i < n; i++) out[i] = (out[i] as number) * (a[i] as number);
  return out;
}

function sameValues(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function maxShift(a: Float64Array, b: Float64Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] as number) - (b[i] as number)));
  return max;
}

/** `sum_i w_i o_i (1 - 1 / m_i)`: seconds the multipliers `m` add at the same base pace. */
function addedTimeS(lengths: Float64Array, paces: Float64Array, m: Float64Array): number {
  let total = 0;
  for (let i = 0; i < lengths.length; i++) {
    const mi = m[i] as number;
    if (mi !== 1) total += (lengths[i] as number) * (paces[i] as number) * (1 - 1 / mi);
  }
  return total;
}

/**
 * The first guess of the arrival times: from the grade-adjusted ideal paces with no factor, or,
 * when the goal is too fast for those (the factors may still make it possible), from an even pace.
 */
function initialArrivals(c: CourseIntervals, goalTimeS: number, model: PaceModel): Float64Array {
  try {
    return arrivalsFromPaces(c.lengths, idealPaces(c, goalTimeS, model).paces);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const total = c.distM.at(-1) as number;
    return Float64Array.from(c.distM, (d) => (goalTimeS * d) / total);
  }
}

/** The plan's pieces for given ideal paces (step 3), plus whatever else the plan type keeps. */
type Segment<T> = (ideal: IdealPaces) => { chosen: Segmentation; extra: T };

/**
 * Steps 1 to 3 with the pace factors: the ideal paces, the plan type's pieces (`segment`), and
 * the factor summary.
 *
 * Time-independent factors are sampled once. Without a time-dependent one this is a single
 * round. With one, it is the fixed-point iteration of `pace-factors.ts`:
 *
 * - Round 0 guess: arrival times from the grade-adjusted ideal paces with no factor (an O(n)
 *   solve, much closer than an even pace).
 * - Each round: sample the time-dependent factors at the current arrival times, build the plan,
 *   and take the arrival times of the plan itself (its constant-pace pieces, which is what the
 *   runner actually follows, not the ideal).
 * - Stop when the newest arrival times are within `FACTOR_ARRIVAL_TOLERANCE_S` of the ones the
 *   factors were sampled at, or when sampling at the newest times gives exactly the same
 *   multipliers (then the next plan would be this one: an exact fixed point, found without
 *   building it; this is what keeps a neutral time-dependent factor at one round), or after
 *   `MAX_FACTOR_ROUNDS` plans, reported as not converged.
 *
 * Each round costs one segmentation plus O(n) per factor, so the time-dependent case costs about
 * `rounds` times a plan without one.
 */
function solvePlan<T>(course: Course, inputs: PlanInputs, segment: Segment<T>) {
  const { goalTimeS, model = danielsPaceModel, factors = DEFAULT_PACE_FACTORS } = inputs;
  const c = courseIntervals(course);
  const n = c.lengths.length;
  if (factors.length === 0) {
    const ideal = idealPaces(c, goalTimeS, model);
    const paceFactors: PaceFactorSummary = { rounds: 1, converged: true, arrivalShiftS: 0, timeS: 0, effects: [] };
    return { ideal, ...segment(ideal), paceFactors };
  }

  const base: PaceFactorContext = {
    course,
    goalTimeS,
    distM: Float64Array.from(c.distM),
    eleM: Float64Array.from(c.eleM),
    arrivalS: initialArrivals(c, goalTimeS, model),
    lengthsM: c.lengths,
    grades: Float64Array.from(c.grades),
    bearingDeg: courseBearingsDeg(course),
  };
  const perFactor = factors.map((f) => sampleFactor(f, base));
  const dynamic = factors.flatMap((f, k) => (f.timeDependent ? [k] : []));
  const staticM = product(
    perFactor.filter((_, k) => !factors[k]!.timeDependent),
    n,
  );
  const dynamicM = (samples: readonly Float64Array[]) =>
    product(
      dynamic.map((k) => samples[k]!),
      n,
    );

  let arrivalS = base.arrivalS;
  let rounds = 0;
  let converged = dynamic.length === 0;
  let arrivalShiftS = 0;
  for (;;) {
    rounds++;
    const m = product([staticM, dynamicM(perFactor)], n);
    const ideal = idealPaces(c, goalTimeS, model, m);
    const result = segment(ideal);
    if (!converged) {
      const next = arrivalsFromPlan(c.lengths, result.chosen);
      const ctx = { ...base, arrivalS: next };
      const resampled = perFactor.map((v, k) => (factors[k]!.timeDependent ? sampleFactor(factors[k]!, ctx) : v));
      if (sameValues(dynamicM(resampled), dynamicM(perFactor))) {
        converged = true;
      } else {
        arrivalShiftS = maxShift(next, arrivalS);
        converged = arrivalShiftS < FACTOR_ARRIVAL_TOLERANCE_S;
      }
      if (!converged && rounds < MAX_FACTOR_ROUNDS) {
        arrivalS = next;
        perFactor.splice(0, perFactor.length, ...resampled);
        continue;
      }
    }
    const effects: PaceFactorEffect[] = factors.map((f, k) => ({
      id: f.id,
      label: f.label,
      timeDependent: f.timeDependent,
      timeS: addedTimeS(c.lengths, ideal.paces, perFactor[k]!),
    }));
    const timeS = addedTimeS(c.lengths, ideal.paces, m);
    const paceFactors: PaceFactorSummary = { rounds, converged, arrivalShiftS, timeS, effects };
    return { ideal, ...result, paceFactors };
  }
}

/** Step 4: each piece of `chosen` as a described segment. */
function describeSegments(course: Course, eleM: readonly number[], chosen: Segmentation, unit: DistanceUnit) {
  const points = course.points;
  const segments: PlanSegment[] = [];
  let totalTimeS = 0;
  for (let p = 0; p + 1 < chosen.bounds.length; p++) {
    const startIndex = chosen.bounds[p]!;
    const endIndex = chosen.bounds[p + 1]!;
    const a = points[startIndex] as CoursePoint;
    const b = points[endIndex] as CoursePoint;
    const segLengthM = b.distM - a.distM;
    const paceSPerM = chosen.values[p]!;
    const timeS = segLengthM * paceSPerM;
    totalTimeS += timeS;
    const avgGrade = segLengthM > 0 ? ((b.ele as number) - (a.ele as number)) / segLengthM : 0;
    const { gainM, lossM } = gainLoss(eleM.slice(startIndex, endIndex + 1), DEFAULT_GAIN_THRESHOLD_M);
    const terrain = classifyTerrain(avgGrade, gainM, lossM, segLengthM);
    segments.push({
      startIndex,
      endIndex,
      startM: a.distM,
      endM: b.distM,
      lengthM: segLengthM,
      paceSPerM,
      timeS,
      avgGrade,
      gainM,
      lossM,
      terrain,
      reason: segmentReason(terrain, avgGrade, gainM, lossM, segLengthM, unit),
    });
  }
  return { segments, totalTimeS };
}

/**
 * The index of the course point nearest `distM` (meters from the start, clamped to the course):
 * where a breakpoint at that distance goes. On a resampled course that is the nearest multiple of
 * the spacing. Ties go to the earlier point.
 */
export function snapToCourse(course: Course, distM: number): number {
  const { points } = course;
  if (points.length === 0) throw new RangeError("snapToCourse: the course has no points");
  let lo = 0;
  let hi = points.length - 1;
  if (!(distM > (points[0] as CoursePoint).distM)) return 0;
  if (distM >= (points[hi] as CoursePoint).distM) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if ((points[mid] as CoursePoint).distM <= distM) lo = mid;
    else hi = mid;
  }
  const below = distM - (points[lo] as CoursePoint).distM;
  const above = (points[hi] as CoursePoint).distM - distM;
  return above < below ? hi : lo;
}

/**
 * The piece bounds (course point indexes, `[0, ..., last]`) for breakpoints at `breakpointsM`:
 * each snapped to its nearest point, sorted, with the start, the finish and repeats dropped.
 */
export function partitionBounds(course: Course, breakpointsM: readonly number[]): number[] {
  const last = course.points.length - 1;
  const inner = [...new Set(breakpointsM.map((d) => snapToCourse(course, d)))]
    .filter((i) => i > 0 && i < last)
    .sort((a, b) => a - b);
  return [0, ...inner, last];
}

/** Breakpoints every `splitM` along a course `lengthM` long, short of the finish: the last split is the remainder. */
export function splitBreakpointsM(lengthM: number, splitM: number): number[] {
  if (!(Number.isFinite(splitM) && splitM > 0)) {
    throw new RangeError(`splitBreakpointsM: splitM must be a positive number of meters, got ${splitM}`);
  }
  if (lengthM / splitM > MAX_PARTITION_SEGMENTS) {
    throw new RangeError(`splitBreakpointsM: more than ${MAX_PARTITION_SEGMENTS} splits`);
  }
  const out: number[] = [];
  for (let k = 1; k * splitM < lengthM; k++) out.push(k * splitM);
  return out;
}

function assembledPlan(
  course: Course,
  inputs: PlanInputs,
  ideal: IdealPaces,
  chosen: Segmentation,
  paceFactors: PaceFactorSummary,
  fields: Pick<Plan, "type" | "paceChanges" | "minSegmentM" | "splitM" | "errorCurve">,
): Plan {
  const { goalTimeS, unit, model = danielsPaceModel } = inputs;
  const { segments, totalTimeS } = describeSegments(course, ideal.eleM, chosen, unit);
  return {
    type: fields.type,
    goalTimeS,
    totalTimeS,
    lengthM: courseLengthM(course),
    unit,
    paceChanges: fields.paceChanges,
    minSegmentM: fields.minSegmentM,
    splitM: fields.splitM,
    error: chosen.error,
    model: { id: model.id, assumption: model.assumption },
    flatPaceSPerM: ideal.flatPaceSPerM,
    segments,
    errorCurve: fields.errorCurve,
    idealPacesSPerM: Array.from(ideal.paces),
    paceFactors,
  };
}

/**
 * The plan for a fixed partition of `course`: a pace change at each of `breakpointsM` (meters
 * from the start, snapped to the nearest course point; see `partitionBounds`), each segment at its
 * length-weighted mean ideal pace. The segment times add up to the goal for any breakpoints. The
 * plan's `type` is `inputs.type` when that is a fixed partition, else `custom`. `paceChanges`,
 * `minSegmentM` and `breakpointsM` in `inputs` are ignored. O(n).
 */
export function planForPartition(course: Course, breakpointsM: readonly number[], inputs: PlanInputs): Plan {
  assertInputs(course, { ...inputs, breakpointsM });
  const bounds = partitionBounds(course, breakpointsM);
  if (bounds.length - 1 > MAX_PARTITION_SEGMENTS) {
    throw new RangeError(`planForPartition: more than ${MAX_PARTITION_SEGMENTS} segments`);
  }
  const { ideal, chosen, paceFactors } = solvePlan(course, inputs, (ideal) => ({
    chosen: segmentPartition(ideal.paces, ideal.lengths, bounds),
    extra: null,
  }));
  const type = inputs.type && inputs.type !== "optimal" ? inputs.type : "custom";
  return assembledPlan(course, inputs, ideal, chosen, paceFactors, {
    type,
    paceChanges: bounds.length - 2,
    minSegmentM: 0,
    splitM: type === "splits" ? (inputs.splitM ?? metersPerUnit(inputs.unit)) : 0,
    errorCurve: [],
  });
}

/**
 * The pacing plan for `course` (at least two points, every one with an elevation; normally
 * `ElevationProfile.course`) and `inputs`, by its plan type. For `optimal`, one dynamic program run
 * gives the plan and the whole error curve; the other types are fixed partitions
 * (`planForPartition`). Throws a `RangeError` on invalid inputs or a goal the model cannot meet.
 */
export function computePlan(course: Course, inputs: PlanInputs): Plan {
  assertInputs(course, inputs);
  const type = inputs.type ?? "optimal";
  if (type === "even") return planForPartition(course, [], inputs);
  if (type === "splits") {
    const splitM = inputs.splitM ?? metersPerUnit(inputs.unit);
    return planForPartition(course, splitBreakpointsM(courseLengthM(course), splitM), { ...inputs, splitM });
  }
  if (type === "custom") return planForPartition(course, inputs.breakpointsM ?? [], inputs);

  const { paceChanges, minSegmentM = 0 } = inputs;
  const curveMax = Math.max(paceChanges, inputs.curveMaxPaceChanges ?? DEFAULT_CURVE_MAX_PACE_CHANGES);
  const lengthM = courseLengthM(course);
  const {
    ideal,
    chosen,
    extra: all,
    paceFactors,
  } = solvePlan(course, inputs, (ideal) => {
    const all = segmentLeastSquares(ideal.paces, ideal.lengths, {
      maxPieces: curveMax + 1,
      minPieceWeight: minSegmentM,
    });
    return { chosen: all[paceChanges]!, extra: all };
  });
  const errorCurve = all.map((s) => ({
    paceChanges: s.maxPieces - 1,
    segments: s.bounds.length - 1,
    error: s.error,
    rmsPaceGapSPerM: Math.sqrt(s.error / lengthM),
  }));
  return assembledPlan(course, inputs, ideal, chosen, paceFactors, {
    type: "optimal",
    paceChanges,
    minSegmentM,
    splitM: 0,
    errorCurve,
  });
}
