/**
 * Ideal (grade-adjusted) pace models. A model turns a course's interval lengths and grades plus a
 * goal time into the pace a runner would ideally hold on every interval, if they could change pace
 * continuously. The segmenter (`segmenter.ts`) then approximates that ideal with a few constant
 * paces a person can actually run.
 *
 * The contract that makes the rest of the pipeline simple: the ideal paces always add up to the
 * goal, `sum_i length_i * pace_i = goal`. Every model must keep it (see `PaceModel`).
 */
import { METERS_PER_MILE } from "./units.ts";

/** A model's ideal paces for one course and goal. */
export interface IdealPaces {
  /** Ideal pace of each interval in seconds per meter, all positive. */
  paces: Float64Array;
  /**
   * The pace this goal implies on flat ground, in seconds per meter: the "base" pace the hill
   * adjustments are added to. Shown to the user next to the stated assumption.
   */
  flatPaceSPerM: number;
}

/**
 * A pluggable ideal pace model. Implementations must return positive paces whose length-weighted
 * sum equals `goalTimeS` (to floating-point precision), and throw a `RangeError` when they cannot
 * (for example, a goal so fast that a long descent would need a zero or negative pace).
 */
export interface PaceModel {
  /** Stable identifier, for example `daniels`. */
  readonly id: string;
  /** The model's assumption in one plain sentence, shown to the user. */
  readonly assumption: string;
  /**
   * Ideal paces for intervals of `lengthsM` meters at `grades` (rise over run, 0.05 is 5%), so
   * that the course takes exactly `goalTimeS` seconds.
   *
   * `multipliers`, when given, are the pace factors' combined multiplier `m_i` of every interval
   * (positive; 1 is no effect, 1.02 is 2% slower; see `pace-factors.ts`). The model scales its
   * grade-adjusted pace of interval `i` by `m_i` and still solves the base pace so the total is
   * the goal. Leaving it out is the same as every `m_i` being exactly 1, to the bit.
   */
  idealPaces(
    lengthsM: ArrayLike<number>,
    grades: ArrayLike<number>,
    goalTimeS: number,
    multipliers?: ArrayLike<number>,
  ): IdealPaces;
}

/** Jack Daniels' uphill rule of thumb: 12 s per mile slower for every 1% of uphill grade. */
export const DANIELS_UPHILL_S_PER_MI_PER_PERCENT = 12;
/** And 7 s per mile faster for every 1% of downhill grade. */
export const DANIELS_DOWNHILL_S_PER_MI_PER_PERCENT = 7;

/** Daniels' adjustment for one grade, in seconds per meter (positive is slower). */
export function danielsAdjustment(grade: number): number {
  const perPercent = grade > 0 ? DANIELS_UPHILL_S_PER_MI_PER_PERCENT : DANIELS_DOWNHILL_S_PER_MI_PER_PERCENT;
  return (perPercent * grade * 100) / METERS_PER_MILE;
}

/**
 * A model of the form `pace_i = base + adjust(grade_i)`: a fixed additive adjustment per grade,
 * on top of one base pace shared by the whole course.
 *
 * The base pace is solved from the goal. Total time is
 * `sum_i w_i (base + a_i) = base * W + sum_i w_i a_i`, where `w_i` are the lengths and `W` their
 * total, so `base = (goal - sum_i w_i a_i) / W`. That one line is what makes the ideal paces add up
 * to the goal exactly, which the segmenter relies on.
 *
 * With pace factor multipliers `m_i` (weather, surface, altitude; see `pace-factors.ts`) the pace
 * of interval `i` is `o_i = (base + a_i) * m_i`: the conditions scale the whole grade-adjusted
 * effort there, so a hot day slows a climb in proportion, not by a fixed amount. Total time is then
 *
 *     T(base) = sum_i w_i (base + a_i) m_i = base * (sum_i w_i m_i) + sum_i w_i a_i m_i,
 *
 * still a straight line in `base` (the multipliers do not depend on it), with a positive slope
 * `sum_i w_i m_i` since every `m_i > 0`. A straight line crosses the goal exactly once, so
 *
 *     base = (goal - sum_i w_i a_i m_i) / (sum_i w_i m_i),
 *
 * one closed-form division with no iterative solver: the factors are just a weight on each
 * interval. (This is why factors multiply rather than enter some other way: anything that keeps
 * `T` linear in `base` keeps this solve exact and O(n).) Without multipliers, or with every
 * `m_i` exactly 1, each step is the unweighted one to the bit, since multiplying by 1 is exact in
 * floating point, so plans without conditions do not change.
 */
export function additivePaceModel(id: string, assumption: string, adjust: (grade: number) => number): PaceModel {
  return {
    id,
    assumption,
    idealPaces(lengthsM, grades, goalTimeS, multipliers) {
      if (lengthsM.length !== grades.length) {
        throw new RangeError(`idealPaces: ${lengthsM.length} lengths but ${grades.length} grades`);
      }
      if (multipliers && multipliers.length !== lengthsM.length) {
        throw new RangeError(`idealPaces: ${lengthsM.length} lengths but ${multipliers.length} multipliers`);
      }
      if (!(Number.isFinite(goalTimeS) && goalTimeS > 0)) {
        throw new RangeError(`idealPaces: the goal must be a positive number of seconds, got ${goalTimeS}`);
      }
      const n = lengthsM.length;
      const adjustments = new Float64Array(n);
      // `weightedM` is the slope `sum_i w_i m_i` and `adjustedS` the intercept `sum_i w_i a_i m_i`
      // of the total time as a line in the base pace (see above).
      let weightedM = 0;
      let adjustedS = 0;
      for (let i = 0; i < n; i++) {
        const w = lengthsM[i] as number;
        if (!(Number.isFinite(w) && w >= 0)) throw new RangeError(`idealPaces: interval ${i} has invalid length ${w}`);
        const a = adjust(grades[i] as number);
        if (!Number.isFinite(a)) throw new RangeError(`idealPaces: interval ${i} has invalid grade ${grades[i]}`);
        const m = multipliers ? (multipliers[i] as number) : 1;
        if (!(Number.isFinite(m) && m > 0))
          throw new RangeError(`idealPaces: interval ${i} has invalid multiplier ${m}`);
        adjustments[i] = a;
        weightedM += w * m;
        adjustedS += w * a * m;
      }
      if (!(weightedM > 0)) throw new RangeError("idealPaces: the course has zero length");
      const flatPaceSPerM = (goalTimeS - adjustedS) / weightedM;
      const paces = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const pace = (flatPaceSPerM + (adjustments[i] as number)) * (multipliers ? (multipliers[i] as number) : 1);
        if (!(pace > 0)) {
          throw new RangeError(`idealPaces: the goal of ${goalTimeS} s is too fast for this course's descents`);
        }
        paces[i] = pace;
      }
      return { paces, flatPaceSPerM };
    },
  };
}

/**
 * The v1 model, from the original project: Jack Daniels' rule of thumb, +12 s/mi per 1% of uphill
 * and -7 s/mi per 1% of downhill, linear in the grade. Uphill costs more than downhill gives back,
 * so a hilly loop is slower than a flat one at the same effort.
 */
export const danielsPaceModel: PaceModel = additivePaceModel(
  "daniels",
  "Each 1% of uphill grade costs 12 s per mile and each 1% of downhill saves 7 s per mile (Jack Daniels' rule of thumb).",
  danielsAdjustment,
);
