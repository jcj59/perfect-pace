import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Course,
  METERS_PER_MILE,
  type Plan,
  type PlanInputs,
  additivePaceModel,
  buildElevationProfile,
  classifyTerrain,
  computePlan,
  paceToUnit,
  parseGpx,
  segmentReason,
} from "../src/index.ts";
import { fixtureDemProvider } from "./support/dem.ts";
import { mulberry32 } from "./support/rng.ts";

/** A straight synthetic course at `spacingM` with elevation `eleAt(distance)`. */
function syntheticCourse(lengthM: number, eleAt: (d: number) => number, spacingM = 10): Course {
  const count = Math.round(lengthM / spacingM) + 1;
  return {
    points: Array.from({ length: count }, (_, i) => {
      const distM = Math.min(lengthM, i * spacingM);
      return { lat: 42 + distM / 111_195, lon: -76, ele: eleAt(distM), distM };
    }),
  };
}

/** A 10 km course: flat 3 km, a 1 km climb at 4%, flat 2 km, a 1 km descent at 4%, flat 3 km. */
const hillCourse = syntheticCourse(10_000, (d) => {
  if (d <= 3000) return 100;
  if (d <= 4000) return 100 + 0.04 * (d - 3000);
  if (d <= 6000) return 140;
  if (d <= 7000) return 140 - 0.04 * (d - 6000);
  return 100;
});

/** Every invariant B4 promises for a plan. */
function checkInvariants(plan: Plan, course: Course, inputs: PlanInputs, label: string): void {
  const { segments } = plan;
  expect(Math.abs(plan.totalTimeS - inputs.goalTimeS), label).toBeLessThan(1);
  const summed = segments.reduce((s, seg) => s + seg.timeS, 0);
  expect(Math.abs(summed - inputs.goalTimeS), label).toBeLessThan(1);
  expect(segments.length, label).toBeGreaterThanOrEqual(1);
  expect(segments.length, label).toBeLessThanOrEqual(inputs.paceChanges + 1);
  expect(segments[0]!.startIndex, label).toBe(0);
  expect(segments.at(-1)!.endIndex, label).toBe(course.points.length - 1);
  expect(segments.at(-1)!.endM, label).toBe(plan.lengthM);
  segments.forEach((seg, i) => {
    if (i > 0) expect(seg.startIndex, label).toBe(segments[i - 1]!.endIndex);
    expect(seg.endIndex, label).toBeGreaterThan(seg.startIndex);
    expect(seg.lengthM, label).toBeCloseTo(seg.endM - seg.startM, 9);
    expect(seg.paceSPerM, label).toBeGreaterThan(0);
    if (segments.length > 1) expect(seg.lengthM, label).toBeGreaterThanOrEqual((inputs.minSegmentM ?? 0) - 1e-6);
    expect(seg.reason, label).toMatch(/^[a-z ]+: [-+]?\d/);
  });
  const curve = plan.errorCurve;
  expect(curve.length, label).toBeGreaterThanOrEqual(inputs.paceChanges + 1);
  curve.forEach((p, k) => {
    expect(p.paceChanges, label).toBe(k);
    expect(p.segments, label).toBeLessThanOrEqual(k + 1);
    if (k > 0) expect(p.error, label).toBeLessThanOrEqual(curve[k - 1]!.error * (1 + 1e-9) + 1e-12);
    expect(p.rmsPaceGapSPerM, label).toBeCloseTo(Math.sqrt(p.error / plan.lengthM), 12);
  });
  expect(curve[inputs.paceChanges]!.segments, label).toBe(segments.length);
}

describe("computePlan", () => {
  it("paces a single hill: slower up, faster down, goal pace on the flats", () => {
    const inputs: PlanInputs = { goalTimeS: 3000, paceChanges: 4, unit: "km" };
    const plan = computePlan(hillCourse, inputs);
    checkInvariants(plan, hillCourse, inputs, "hill");
    expect(plan.segments.map((s) => [s.startM, s.endM])).toEqual([
      [0, 3000],
      [3000, 4000],
      [4000, 6000],
      [6000, 7000],
      [7000, 10_000],
    ]);
    const [flat, up, top, down] = plan.segments.map((s) => paceToUnit(s.paceSPerM, "mi"));
    // 4% is +48 s/mi up and -28 s/mi down around the flat pace, which absorbs the net 20 s/mi
    // over 2 of the 10 km.
    expect(up! - flat!).toBeCloseTo(48, 6);
    expect(down! - flat!).toBeCloseTo(-28, 6);
    expect(top).toBeCloseTo(flat!, 6);
    expect(paceToUnit(plan.flatPaceSPerM, "mi")).toBeCloseTo(flat!, 6);
    expect(plan.segments.map((s) => s.reason)).toEqual([
      "flat: 0.0% over 3.0 km",
      "climb: +4.0% over 1.0 km",
      "flat: 0.0% over 2.0 km",
      "descent: -4.0% over 1.0 km",
      "flat: 0.0% over 3.0 km",
    ]);
    expect(plan.segments[1]!.gainM).toBeCloseTo(40, 6);
    expect(plan.segments[3]!.lossM).toBeCloseTo(40, 6);
    expect(plan.model.id).toBe("daniels");
    expect(plan.idealPacesSPerM).toHaveLength(hillCourse.points.length - 1);
  });

  it("uses fewer segments when fewer suffice, and the error curve flattens", () => {
    const plan = computePlan(hillCourse, { goalTimeS: 3000, paceChanges: 8, unit: "mi" });
    expect(plan.segments).toHaveLength(5);
    expect(plan.paceChanges).toBe(8);
    expect(plan.errorCurve.slice(4).every((p) => p.error < 1e-9)).toBe(true);
    expect(plan.errorCurve[0]!.error).toBeGreaterThan(plan.errorCurve[2]!.error);
  });

  it("merges the hill into its neighbors to respect a minimum segment length", () => {
    const inputs: PlanInputs = { goalTimeS: 3000, paceChanges: 4, unit: "km", minSegmentM: 2500 };
    const plan = computePlan(hillCourse, inputs);
    checkInvariants(plan, hillCourse, inputs, "hill, 2.5 km minimum");
    expect(plan.minSegmentM).toBe(2500);
    expect(plan.segments.length).toBeLessThanOrEqual(4);
  });

  it("returns one segment when the minimum is longer than the course", () => {
    const plan = computePlan(hillCourse, { goalTimeS: 3000, paceChanges: 6, unit: "km", minSegmentM: 20_000 });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.timeS).toBeCloseTo(3000, 6);
  });

  it("extends the error curve to the default, to curveMaxPaceChanges, and never below paceChanges", () => {
    const base = { goalTimeS: 3000, unit: "km" } as const;
    expect(computePlan(hillCourse, { ...base, paceChanges: 2 }).errorCurve).toHaveLength(11);
    expect(computePlan(hillCourse, { ...base, paceChanges: 2, curveMaxPaceChanges: 4 }).errorCurve).toHaveLength(5);
    expect(computePlan(hillCourse, { ...base, paceChanges: 12, curveMaxPaceChanges: 4 }).errorCurve).toHaveLength(13);
  });

  it("does not depend on the goal for where segments go (the model is additive)", () => {
    const a = computePlan(hillCourse, { goalTimeS: 2400, paceChanges: 3, unit: "km" });
    const b = computePlan(hillCourse, { goalTimeS: 3600, paceChanges: 3, unit: "km" });
    expect(a.segments.map((s) => s.startIndex)).toEqual(b.segments.map((s) => s.startIndex));
    expect(b.totalTimeS).toBeCloseTo(3600, 6);
  });

  it("accepts another pace model", () => {
    const flatModel = additivePaceModel("flat", "Hills do not matter.", () => 0);
    const plan = computePlan(hillCourse, { goalTimeS: 3000, paceChanges: 5, unit: "km", model: flatModel });
    expect(plan.segments).toHaveLength(1);
    expect(plan.model).toEqual({ id: "flat", assumption: "Hills do not matter." });
  });

  it("holds every invariant on seeded random courses", () => {
    const seed = 777;
    const next = mulberry32(seed);
    for (let trial = 0; trial < 25; trial++) {
      const lengthM = 500 + 15_000 * next();
      const phase = 10 * next();
      const amp = 5 + 40 * next();
      const course = syntheticCourse(
        lengthM,
        (d) => 100 + amp * Math.sin(d / 700 + phase) + 0.3 * amp * Math.sin(d / 130),
        5 + 20 * next(),
      );
      const inputs: PlanInputs = {
        goalTimeS: (lengthM / METERS_PER_MILE) * (300 + 300 * next()),
        paceChanges: Math.floor(next() * 12),
        unit: next() < 0.5 ? "mi" : "km",
        minSegmentM: next() < 0.3 ? 0 : 1000 * next(),
      };
      checkInvariants(computePlan(course, inputs), course, inputs, `seed ${seed} trial ${trial}`);
    }
  });

  describe("on every fixture course", async () => {
    const dir = join(import.meta.dirname, "fixtures", "gpx");
    const profiles = await Promise.all(
      readdirSync(dir)
        .filter((f) => f.endsWith(".gpx"))
        .sort()
        .map(async (file) => {
          const gpx = parseGpx(readFileSync(join(dir, file), "utf8"));
          const track = gpx.tracks[gpx.defaultTrack]!;
          return [file, await buildElevationProfile(track.course, { provider: fixtureDemProvider() })] as const;
        }),
    );
    it.each(profiles.filter(([, p]) => p.course.points.length >= 2))("%s holds every invariant", (file, profile) => {
      for (const paceChanges of [0, 2, 5, 9]) {
        for (const unit of ["mi", "km"] as const) {
          const lengthMi = profile.course.points.at(-1)!.distM / METERS_PER_MILE;
          const inputs: PlanInputs = { goalTimeS: lengthMi * 480, paceChanges, unit, minSegmentM: 300 };
          checkInvariants(
            computePlan(profile.course, inputs),
            profile.course,
            inputs,
            `${file} ${paceChanges} ${unit}`,
          );
        }
      }
    });
  });

  it.each([
    [{ points: [] }, {}, /at least two points/],
    [
      {
        points: [
          { lat: 0, lon: 0, ele: 1, distM: 0 },
          { lat: 0, lon: 0, distM: 10 },
        ],
      },
      {},
      /point 1 has no elevation/,
    ],
    [
      {
        points: [
          { lat: 0, lon: 0, ele: 1, distM: 0 },
          { lat: 0, lon: 0, ele: 1, distM: 0 },
        ],
      },
      {},
      /zero length/,
    ],
    [hillCourse, { goalTimeS: 0 }, /goal must be a positive/],
    [hillCourse, { goalTimeS: NaN }, /goal must be a positive/],
    [hillCourse, { paceChanges: -1 }, /paceChanges/],
    [hillCourse, { paceChanges: 1.5 }, /paceChanges/],
    [hillCourse, { minSegmentM: -5 }, /minSegmentM/],
    [hillCourse, { curveMaxPaceChanges: 2.5 }, /curveMaxPaceChanges/],
  ] as [Course, Partial<PlanInputs>, RegExp][])("rejects invalid input %#", (course, overrides, message) => {
    expect(() => computePlan(course, { goalTimeS: 3000, paceChanges: 3, unit: "mi", ...overrides })).toThrow(message);
  });
});

describe("classifyTerrain", () => {
  it.each([
    [0.01, 0, 0, 1000, "climb"],
    [-0.012, 0, 0, 1000, "descent"],
    [0.002, 10, 8, 1000, "rolling"],
    [0.005, 2, 0, 1000, "gentle climb"],
    [-0.004, 0, 4, 1000, "gentle descent"],
    [0.001, 1, 0, 1000, "flat"],
    [0, 0, 0, 0, "flat"],
  ] as const)("grade %s, gain %s, loss %s over %s m is %s", (grade, gain, loss, length, terrain) => {
    expect(classifyTerrain(grade, gain, loss, length)).toBe(terrain);
  });
});

describe("segmentReason", () => {
  it("states the grade and distance in the chosen units", () => {
    expect(segmentReason("climb", 0.038, 37, 0, 965.6, "mi")).toBe("climb: +3.8% over 0.6 mi");
    expect(segmentReason("descent", -0.021, 0, 40, 1900, "km")).toBe("descent: -2.1% over 1.9 km");
    expect(segmentReason("flat", -0.0004, 0, 0, 4000, "km")).toBe("flat: 0.0% over 4.0 km");
    expect(segmentReason("gentle climb", 0.004, 3, 0, 120, "mi")).toBe("gentle climb: +0.4% over 0.07 mi");
  });

  it("gives up and down, in feet for miles and meters for kilometers, for rolling terrain", () => {
    expect(segmentReason("rolling", 0.001, 40, 38, 3218.7, "mi")).toBe("rolling: +131 ft / -125 ft over 2.0 mi");
    expect(segmentReason("rolling", 0.001, 40, 38, 3218.7, "km")).toBe("rolling: +40 m / -38 m over 3.2 km");
  });
});
