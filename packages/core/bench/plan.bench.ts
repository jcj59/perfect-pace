import { bench, describe } from "vitest";
import {
  type Course,
  DEFAULT_PACE_FACTORS,
  METERS_PER_MILE,
  type PaceFactor,
  computePlan,
  replacePaceFactor,
} from "../src/index.ts";

// A marathon at 10 m spacing (4,220 points) with rolling hills of several wavelengths, like the
// smoothed profile `buildElevationProfile` produces.
const spacingM = 10;
const count = 4220;
const course: Course = {
  points: Array.from({ length: count }, (_, i) => {
    const d = i * spacingM;
    const ele = 100 + 25 * Math.sin(d / 2300) + 8 * Math.sin(d / 610) + 3 * Math.sin(d / 170);
    return { lat: 42 + d / 111_195, lon: -71, ele, distM: d };
  }),
};
const goalTimeS = 3 * 3600;

// A stand-in for real weather: 3% slower for every hour since the start, sampled at each point's
// arrival time, so the plan needs the arrival-time iteration (2 rounds on this course).
const heat: PaceFactor = {
  id: "weather",
  label: "Heat",
  timeDependent: true,
  multipliers: (ctx) =>
    Float64Array.from(ctx.lengthsM, (_, i) => 1 + (0.03 * (ctx.arrivalS[i]! + ctx.arrivalS[i + 1]!)) / 7200),
};
const withHeat = replacePaceFactor(DEFAULT_PACE_FACTORS, heat);

// The worst case: a factor that flips the first half between slow and fast depending on when the
// runner reaches halfway, so the iteration never settles and runs to `MAX_FACTOR_ROUNDS` (6).
const contrary: PaceFactor = {
  id: "weather",
  label: "Contrary",
  timeDependent: true,
  multipliers: (ctx) => {
    const half = Math.floor(ctx.lengthsM.length / 2);
    const early = ctx.arrivalS[half]! < ctx.goalTimeS / 2;
    return Float64Array.from(ctx.lengthsM, (_, i) => (i < half ? (early ? 1.3 : 0.8) : 1));
  },
};
const withContrary = replacePaceFactor(DEFAULT_PACE_FACTORS, contrary);

describe("plan", () => {
  // The B4 budget: a recompute after any input change, with the full error curve (0 to 10 changes).
  bench("computePlan marathon at 10 m, 6 changes, 0.2 mi minimum", () => {
    computePlan(course, { goalTimeS, paceChanges: 6, unit: "mi", minSegmentM: 0.2 * METERS_PER_MILE });
  });

  // A heavy case: twice the slider's default curve, no minimum to cut down the candidates.
  bench("computePlan marathon at 10 m, 20 changes, no minimum", () => {
    computePlan(course, { goalTimeS, paceChanges: 20, unit: "km" });
  });

  // B11: a fixed partition (here a split every 100 m, far finer than any runner picks) on the same course.
  bench("computePlan marathon at 10 m, 100 m splits", () => {
    computePlan(course, { goalTimeS, paceChanges: 0, unit: "km", type: "splits", splitM: 100 });
  });

  // B14: a time-dependent factor rebuilds the plan once per round of the arrival-time iteration,
  // so a plan costs about `rounds` times the one-round case above. Budgets are 50 ms a round.
  bench("computePlan marathon at 10 m, 6 changes, time-dependent factor (2 rounds)", () => {
    computePlan(course, {
      goalTimeS,
      paceChanges: 6,
      unit: "mi",
      minSegmentM: 0.2 * METERS_PER_MILE,
      factors: withHeat,
    });
  });

  bench("computePlan marathon at 10 m, 6 changes, non-converging factor (6 rounds, the cap)", () => {
    computePlan(course, {
      goalTimeS,
      paceChanges: 6,
      unit: "mi",
      minSegmentM: 0.2 * METERS_PER_MILE,
      factors: withContrary,
    });
  });
});
