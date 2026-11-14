/**
 * The pacing plan: `computePlan(course, inputs)` runs the pace model over the course's grades, the
 * exact segmenter over the resulting ideal paces, and describes each piece in words.
 *
 * Pipeline, all in meters and seconds:
 *
 * 1. Interval lengths `w_i` and grades come from the course's points (normally the smoothed,
 *    resampled course of `buildElevationProfile`).
 * 2. The pace model gives the ideal pace `o_i` of every interval, scaled so that
 *    `sum_i w_i o_i` is the goal time.
 * 3. `segmentLeastSquares` picks at most `paceChanges + 1` contiguous pieces minimizing
 *    `sum_i w_i (p_i - o_i)^2`, each at least `minSegmentM` long. Each piece's pace is its
 *    length-weighted mean ideal pace, which makes the plan's total time equal the goal (see the
 *    `segmenter.ts` module doc for why that is automatic).
 * 4. Each piece gets its average grade, gain and loss, a terrain label and a short reason.
 */
import { type Course, type CoursePoint, courseLengthM } from "./course.ts";
import { DEFAULT_GAIN_THRESHOLD_M, MAX_ABS_GRADE, computeGrades, gainLoss } from "./elevation.ts";
import { type PaceModel, danielsPaceModel } from "./pace-model.ts";
import { segmentLeastSquares } from "./segmenter.ts";
import { type DistanceUnit, metersToUnit } from "./units.ts";

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
  goalTimeS: number;
  /** The plan's predicted finish time, `sum` of segment times. Equals the goal within rounding. */
  totalTimeS: number;
  lengthM: number;
  unit: DistanceUnit;
  /** The pace changes asked for; `segments.length - 1` may be fewer. */
  paceChanges: number;
  minSegmentM: number;
  model: { id: string; assumption: string };
  /** The goal's pace on flat ground, seconds per meter. */
  flatPaceSPerM: number;
  segments: PlanSegment[];
  /** Optimal error for every allowed number of pace changes, from 0 up. */
  errorCurve: ErrorCurvePoint[];
  /** The model's ideal pace of every course interval `i..i + 1`, seconds per meter. */
  idealPacesSPerM: number[];
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

/**
 * The pacing plan for `course` (at least two points, every one with an elevation; normally
 * `ElevationProfile.course`) and `inputs`. One dynamic program run gives the plan and the whole
 * error curve. Throws a `RangeError` on invalid inputs or a goal the model cannot meet.
 */
export function computePlan(course: Course, inputs: PlanInputs): Plan {
  assertInputs(course, inputs);
  const { goalTimeS, paceChanges, unit, minSegmentM = 0, model = danielsPaceModel } = inputs;
  const curveMax = Math.max(paceChanges, inputs.curveMaxPaceChanges ?? DEFAULT_CURVE_MAX_PACE_CHANGES);
  const points = course.points;
  const distM = points.map((p) => p.distM);
  const eleM = points.map((p) => p.ele as number);
  const n = points.length - 1;
  const lengths = new Float64Array(n);
  for (let i = 0; i < n; i++) lengths[i] = (distM[i + 1] as number) - (distM[i] as number);
  const grades = computeGrades(distM, eleM, MAX_ABS_GRADE);
  const { paces, flatPaceSPerM } = model.idealPaces(lengths, grades, goalTimeS);

  const lengthM = courseLengthM(course);
  const all = segmentLeastSquares(paces, lengths, { maxPieces: curveMax + 1, minPieceWeight: minSegmentM });
  const errorCurve = all.map((s) => ({
    paceChanges: s.maxPieces - 1,
    segments: s.bounds.length - 1,
    error: s.error,
    rmsPaceGapSPerM: Math.sqrt(s.error / lengthM),
  }));
  const chosen = all[paceChanges]!;

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

  return {
    goalTimeS,
    totalTimeS,
    lengthM,
    unit,
    paceChanges,
    minSegmentM,
    model: { id: model.id, assumption: model.assumption },
    flatPaceSPerM,
    segments,
    errorCurve,
    idealPacesSPerM: Array.from(paces),
  };
}
