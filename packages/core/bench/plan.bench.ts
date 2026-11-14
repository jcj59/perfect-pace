import { bench, describe } from "vitest";
import { type Course, METERS_PER_MILE, computePlan } from "../src/index.ts";

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

describe("plan", () => {
  // The B4 budget: a recompute after any input change, with the full error curve (0 to 10 changes).
  bench("computePlan marathon at 10 m, 6 changes, 0.2 mi minimum", () => {
    computePlan(course, { goalTimeS, paceChanges: 6, unit: "mi", minSegmentM: 0.2 * METERS_PER_MILE });
  });

  // A heavy case: twice the slider's default curve, no minimum to cut down the candidates.
  bench("computePlan marathon at 10 m, 20 changes, no minimum", () => {
    computePlan(course, { goalTimeS, paceChanges: 20, unit: "km" });
  });
});
