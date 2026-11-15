/**
 * Pace factors: race-day conditions (weather, running surface, altitude) that make the ideal pace
 * slower or faster at each point of the course, on top of the grade adjustment of the pace model.
 *
 * Every factor gives a positive multiplier per course interval (1 is no effect, 1.03 is 3%
 * slower, 0.99 is 1% faster). The plan multiplies them together into `m_i` and the ideal pace of
 * interval `i` becomes
 *
 *     o_i = (b + g_i) * m_i
 *
 * where `g_i` is the pace model's grade adjustment and `b` the base (flat, neutral conditions)
 * pace. Total time `sum_i w_i o_i` is still a straight line in `b`, so `b` stays a closed-form
 * solve that hits the goal exactly (`additivePaceModel` derives it), and the segmenter and every
 * plan type work unchanged on the new `o_i`.
 *
 * **Time-dependent factors.** Weather depends on when the runner reaches each point, and that
 * depends on the plan, which depends on the weather: a circular definition. `computePlan` resolves
 * it by fixed-point iteration (a Picard iteration, the simplest way to solve `x = F(x)`): start
 * from a guess of the arrival times, sample the factors at those times, build the plan, take its
 * arrival times, and repeat until they move less than `FACTOR_ARRIVAL_TOLERANCE_S`. It converges
 * fast because the map is a strong contraction: a factor shifts pace by a few percent, so a change
 * of `d` seconds in the arrival times changes the next round's arrival times by a few percent of
 * `d` at most (2 to 3 rounds in practice). A factor that reacts violently to its own arrival times
 * could cycle instead, so the rounds are capped at `MAX_FACTOR_ROUNDS` and the plan reports that
 * it did not converge rather than looping.
 *
 * This module only defines the interface and registers neutral factors (multiplier exactly 1
 * everywhere), so plans are unchanged until a real model replaces one (see `replacePaceFactor`).
 */
import type { Course } from "./course.ts";

/**
 * Everything a factor may base its multipliers on. Arrays are per course point (`n + 1` of them)
 * or per interval `points[i]..points[i + 1]` (`n` of them, aligned with the multipliers a factor
 * returns). Factors must treat them as read only.
 */
export interface PaceFactorContext {
  /** The course being paced (positions for weather and surface lookups). */
  readonly course: Course;
  /** The goal finish time, seconds. */
  readonly goalTimeS: number;
  /** Per point: meters from the start. */
  readonly distM: Float64Array;
  /** Per point: absolute elevation, meters. */
  readonly eleM: Float64Array;
  /**
   * Per point: seconds after the start the runner reaches it. For time-dependent factors these
   * come from the current round's plan; for the first round, and for factors that are not time
   * dependent, from the grade-adjusted ideal paces without any factor.
   */
  readonly arrivalS: Float64Array;
  /** Per interval: length, meters. */
  readonly lengthsM: Float64Array;
  /** Per interval: grade (rise over run, clamped like the pace model's input). */
  readonly grades: Float64Array;
  /** Per interval: course bearing, degrees clockwise from true north (`courseBearingsDeg`). */
  readonly bearingDeg: Float64Array;
}

/** One race-day condition that scales the ideal pace. */
export interface PaceFactor {
  /** Stable identifier, unique within a plan, for example `weather`. */
  readonly id: string;
  /** A short name for the user, for example `Weather`. */
  readonly label: string;
  /**
   * Whether the multipliers depend on `arrivalS`. Only these factors are sampled again in each
   * round of the arrival-time iteration; the others are evaluated once.
   */
  readonly timeDependent: boolean;
  /**
   * The multiplier of every interval: `ctx.lengthsM.length` positive finite numbers, 1 for no
   * effect. Called once per plan, or once per round when `timeDependent`.
   */
  multipliers(ctx: PaceFactorContext): ArrayLike<number>;
}

/** What one factor did to the plan. */
export interface PaceFactorEffect {
  id: string;
  label: string;
  timeDependent: boolean;
  /**
   * Seconds this factor adds to the finish (negative when it saves time) at the same effort: the
   * plan's time minus the time at the same base pace with this factor's multipliers set to 1,
   * `sum_i w_i o_i (1 - 1 / f_i)`. (At a fixed goal the total never changes, so "same effort" is
   * the comparison that means something: how much faster this course would be without it.) It
   * keeps the other factors' multipliers and the arrival times as they are, so it is one O(n) sum
   * with no new plan. Exactly 0 for a neutral factor.
   */
  timeS: number;
}

/** How the factors were applied to a plan. */
export interface PaceFactorSummary {
  /**
   * Plans built: 1 without a time-dependent factor, else the rounds of the arrival-time
   * iteration (at most `MAX_FACTOR_ROUNDS`).
   */
  rounds: number;
  /** False only when the iteration hit `MAX_FACTOR_ROUNDS` with arrival times still moving. */
  converged: boolean;
  /**
   * The largest change of an arrival time between the last plan and the times its factors were
   * sampled at, seconds (0 without a time-dependent factor or when the samples did not change).
   */
  arrivalShiftS: number;
  /**
   * Seconds all the factors together add at the same effort, `sum_i w_i o_i (1 - 1 / m_i)`: the
   * goal minus the time at the same base pace with no factor. Not the sum of `effects`, which
   * differs from it by the factors' interaction (second order in their size).
   */
  timeS: number;
  /** One entry per factor, in the order they were given. */
  effects: PaceFactorEffect[];
}

/** The iteration stops once no arrival time moves more than this, seconds. */
export const FACTOR_ARRIVAL_TOLERANCE_S = 30;

/** The most plans one `computePlan` builds for time-dependent factors. */
export const MAX_FACTOR_ROUNDS = 6;

/** The ids of the conditions the app models, in display order. */
export const PACE_FACTOR_IDS = ["weather", "surface", "altitude"] as const;
export type PaceFactorId = (typeof PACE_FACTOR_IDS)[number];

/** A factor with no effect: every multiplier exactly 1. A placeholder until its model lands. */
export function neutralPaceFactor(id: string, label: string, timeDependent: boolean): PaceFactor {
  return {
    id,
    label,
    timeDependent,
    multipliers: (ctx) => new Float64Array(ctx.lengthsM.length).fill(1),
  };
}

/** Weather at the time the runner gets to each point (neutral until its model lands). */
export const neutralWeatherFactor: PaceFactor = neutralPaceFactor("weather", "Weather", true);
/** The running surface underfoot (neutral until its model lands). */
export const neutralSurfaceFactor: PaceFactor = neutralPaceFactor("surface", "Surface", false);
/** Altitude relative to where the runner trains (neutral until its model lands). */
export const neutralAltitudeFactor: PaceFactor = neutralPaceFactor("altitude", "Altitude", false);

/**
 * The factors every plan applies unless `PlanInputs.factors` says otherwise, one per
 * `PACE_FACTOR_IDS` entry. All neutral for now, so plans match the grade-only model to the bit.
 */
export const DEFAULT_PACE_FACTORS: readonly PaceFactor[] = [
  neutralWeatherFactor,
  neutralSurfaceFactor,
  neutralAltitudeFactor,
];

/**
 * `factors` with the one sharing `factor.id` replaced by it (appended when none does): how a
 * conditions model takes the place of its neutral factor, for example
 * `replacePaceFactor(DEFAULT_PACE_FACTORS, weatherFactor(forecast))`.
 */
export function replacePaceFactor(factors: readonly PaceFactor[], factor: PaceFactor): PaceFactor[] {
  const out = factors.map((f) => (f.id === factor.id ? factor : f));
  if (!out.includes(factor)) out.push(factor);
  return out;
}
