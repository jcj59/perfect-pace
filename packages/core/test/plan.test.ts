import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Course,
  MAX_PARTITION_SEGMENTS,
  METERS_PER_MILE,
  PLAN_TYPES,
  type Plan,
  type PlanInputs,
  additivePaceModel,
  buildElevationProfile,
  classifyTerrain,
  computePlan,
  paceToUnit,
  parseGpx,
  partitionBounds,
  planForPartition,
  segmentReason,
  snapToCourse,
  splitBreakpointsM,
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
    it.each(profiles.filter(([, p]) => p.course.points.length >= 2))(
      "%s holds every plan type's invariants",
      (file, profile) => {
        const lengthM = profile.course.points.at(-1)!.distM;
        for (const unit of ["mi", "km"] as const) {
          const inputs: PlanInputs = {
            goalTimeS: (lengthM / METERS_PER_MILE) * 480,
            paceChanges: 0,
            unit,
            minSegmentM: 300,
          };
          const even = computePlan(profile.course, { ...inputs, type: "even" });
          expect(even.segments, file).toEqual(computePlan(profile.course, inputs).segments);
          checkPartition(even, profile.course, inputs, [0, profile.course.points.length - 1], `${file} even`);
          const splits = computePlan(profile.course, { ...inputs, type: "splits" });
          const splitBounds = partitionBounds(
            profile.course,
            splitBreakpointsM(lengthM, unit === "mi" ? METERS_PER_MILE : 1000),
          );
          checkPartition(splits, profile.course, inputs, splitBounds, `${file} splits ${unit}`);
          const breakpointsM = [0.2, 0.5, 0.55, 0.9].map((f) => f * lengthM);
          const custom = computePlan(profile.course, { ...inputs, type: "custom", breakpointsM });
          checkPartition(
            custom,
            profile.course,
            inputs,
            partitionBounds(profile.course, breakpointsM),
            `${file} custom`,
          );
        }
      },
    );
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

/**
 * Every invariant B11 promises for a fixed-partition plan: the goal within 1 s, one segment per
 * piece of `bounds`, each at the length-weighted mean of the ideal pace over it, and the error
 * the plan states.
 */
function checkPartition(plan: Plan, course: Course, inputs: PlanInputs, bounds: number[], label: string): void {
  const { segments } = plan;
  expect(Math.abs(plan.totalTimeS - inputs.goalTimeS), label).toBeLessThan(1);
  expect(Math.abs(segments.reduce((s, seg) => s + seg.timeS, 0) - inputs.goalTimeS), label).toBeLessThan(1);
  expect([0, ...segments.map((seg) => seg.endIndex)], label).toEqual(bounds);
  expect(plan.paceChanges, label).toBe(segments.length - 1);
  expect(plan.errorCurve, label).toEqual([]);
  expect(plan.minSegmentM, label).toBe(0);
  const pts = course.points;
  let error = 0;
  segments.forEach((seg, p) => {
    if (p > 0) expect(seg.startIndex, label).toBe(segments[p - 1]!.endIndex);
    let w = 0;
    let wo = 0;
    for (let i = seg.startIndex; i < seg.endIndex; i++) {
      const len = pts[i + 1]!.distM - pts[i]!.distM;
      w += len;
      wo += len * plan.idealPacesSPerM[i]!;
    }
    expect(seg.paceSPerM, label).toBeCloseTo(wo / w, 12);
    for (let i = seg.startIndex; i < seg.endIndex; i++) {
      error += (pts[i + 1]!.distM - pts[i]!.distM) * (seg.paceSPerM - plan.idealPacesSPerM[i]!) ** 2;
    }
  });
  expect(plan.error, label).toBeCloseTo(error, 6);
}

describe("plan types", () => {
  const base: PlanInputs = { goalTimeS: 3000, paceChanges: 3, unit: "km", minSegmentM: 500 };

  it("paces Even as one segment, exactly the optimal plan with no pace changes", () => {
    const even = computePlan(hillCourse, { ...base, type: "even" });
    const optimal = computePlan(hillCourse, { ...base, paceChanges: 0 });
    expect(even.type).toBe("even");
    expect(even.segments).toEqual(optimal.segments);
    expect(even.error).toBe(optimal.errorCurve[0]!.error);
    expect(even.totalTimeS).toBe(optimal.totalTimeS);
    expect(even.segments[0]!.paceSPerM * 10_000).toBeCloseTo(3000, 9);
    checkPartition(even, hillCourse, base, [0, hillCourse.points.length - 1], "even");
  });

  it("states the optimal plan's own error and type", () => {
    const optimal = computePlan(hillCourse, base);
    expect(optimal.type).toBe("optimal");
    expect(optimal.error).toBe(optimal.errorCurve[3]!.error);
    expect(optimal.splitM).toBe(0);
  });

  it("splits every split length, with the remainder last", () => {
    const plan = computePlan(hillCourse, { ...base, type: "splits", splitM: 1609.344 });
    expect(plan.type).toBe("splits");
    expect(plan.splitM).toBe(1609.344);
    // 10 km is 6 whole miles and 0.21 mi; each break lands on the 10 m point nearest its mile.
    expect(plan.segments.map((s) => s.endM)).toEqual([1610, 3220, 4830, 6440, 8050, 9660, 10_000]);
    checkPartition(plan, hillCourse, base, partitionBounds(hillCourse, splitBreakpointsM(10_000, 1609.344)), "mi");
  });

  it("defaults the split to one unit, and leaves no sliver when the course is a whole number of splits", () => {
    const km = computePlan(hillCourse, { ...base, type: "splits" });
    expect(km.splitM).toBe(1000);
    expect(km.segments).toHaveLength(10);
    expect(km.segments.every((s) => s.lengthM === 1000)).toBe(true);
    const mi = computePlan(hillCourse, { ...base, unit: "mi", type: "splits" });
    expect(mi.splitM).toBe(METERS_PER_MILE);
    expect(computePlan(hillCourse, { ...base, type: "splits", splitM: 20_000 }).segments).toHaveLength(1);
  });

  it("puts custom breakpoints on the nearest course points, in order, without repeats or ends", () => {
    const plan = computePlan(hillCourse, {
      ...base,
      type: "custom",
      breakpointsM: [7004, 2996, 3001, 0, 10_000, -5, 12_000],
    });
    expect(plan.type).toBe("custom");
    expect(plan.segments.map((s) => [s.startM, s.endM])).toEqual([
      [0, 3000],
      [3000, 7000],
      [7000, 10_000],
    ]);
    checkPartition(plan, hillCourse, base, [0, 300, 700, 1000], "custom");
    expect(computePlan(hillCourse, { ...base, type: "custom" }).segments).toHaveLength(1);
    expect(computePlan(hillCourse, { ...base, type: "custom", breakpointsM: [] }).segments).toEqual(
      computePlan(hillCourse, { ...base, type: "even" }).segments,
    );
  });

  it("takes a partition directly, as custom unless told it is another fixed type", () => {
    const plan = planForPartition(hillCourse, [4000, 6000], base);
    expect(plan.type).toBe("custom");
    expect(plan.segments.map((s) => s.endM)).toEqual([4000, 6000, 10_000]);
    expect(planForPartition(hillCourse, [], { ...base, type: "even" }).type).toBe("even");
    expect(planForPartition(hillCourse, [5000], { ...base, type: "optimal" }).type).toBe("custom");
    // Breakpoints at the hill's edges give it its own paces: slower up, faster down.
    const hill = planForPartition(hillCourse, [3000, 4000, 6000, 7000], base);
    const [flat, up, top, down] = hill.segments.map((s) => s.paceSPerM);
    expect(up).toBeGreaterThan(flat!);
    expect(down).toBeLessThan(top!);
  });

  it("is never closer to the ideal pace than the optimal plan with as many changes", () => {
    for (const breakpointsM of [[2500], [1000, 5000], [3000, 4000, 6000, 7000]]) {
      const custom = computePlan(hillCourse, { ...base, minSegmentM: 0, type: "custom", breakpointsM });
      const optimal = computePlan(hillCourse, { ...base, minSegmentM: 0, paceChanges: breakpointsM.length });
      expect(custom.error).toBeGreaterThanOrEqual(optimal.error * (1 - 1e-9));
    }
  });

  it("holds every invariant for every type on seeded random courses", () => {
    const seed = 1811;
    const next = mulberry32(seed);
    for (let trial = 0; trial < 30; trial++) {
      const lengthM = 500 + 30_000 * next();
      const amp = 5 + 40 * next();
      const course = syntheticCourse(
        lengthM,
        (d) => 100 + amp * Math.sin(d / 900) + 0.2 * amp * Math.sin(d / 97),
        5 + 15 * next(),
      );
      const inputs: PlanInputs = {
        goalTimeS: (lengthM / METERS_PER_MILE) * (300 + 300 * next()),
        paceChanges: 4,
        unit: next() < 0.5 ? "mi" : "km",
        splitM: 200 + 5000 * next(),
        breakpointsM: Array.from({ length: Math.floor(next() * 12) }, () => lengthM * (next() * 1.2 - 0.1)),
      };
      const label = `seed ${seed} trial ${trial}`;
      for (const type of PLAN_TYPES) {
        const plan = computePlan(course, { ...inputs, type });
        expect(plan.type, label).toBe(type);
        if (type === "optimal") continue;
        const breaks =
          type === "even" ? [] : type === "splits" ? splitBreakpointsM(lengthM, inputs.splitM!) : inputs.breakpointsM!;
        checkPartition(plan, course, inputs, partitionBounds(course, breaks), `${label} ${type}`);
      }
    }
  });

  it("rejects a bad split, too many splits, a breakpoint that is not a number or an unknown type", () => {
    for (const [overrides, message] of [
      [{ type: "splits", splitM: 0 }, /splitM/],
      [{ type: "splits", splitM: NaN }, /splitM/],
      [{ type: "splits", splitM: 10_000 / (MAX_PARTITION_SEGMENTS + 1) }, /more than 1000 splits/],
      [{ type: "custom", breakpointsM: [100, Infinity] }, /breakpoint/],
      [{ type: "fastest" }, /unknown plan type/],
    ] as [Partial<PlanInputs>, RegExp][]) {
      expect(() => computePlan(hillCourse, { ...base, ...overrides })).toThrow(message);
    }
    const fine = syntheticCourse(20_000, () => 100, 5);
    const many = Array.from({ length: MAX_PARTITION_SEGMENTS + 5 }, (_, i) => (i + 1) * 15);
    expect(() => planForPartition(fine, many, base)).toThrow(/more than 1000 segments/);
    expect(() => splitBreakpointsM(1000, -1)).toThrow(/splitM/);
  });
});

describe("snapToCourse", () => {
  const course = syntheticCourse(95, () => 0); // points at 0, 10, ..., 90, 95

  it("finds the nearest point, the earlier on a tie, clamped to the course", () => {
    expect(snapToCourse(course, 14)).toBe(1);
    expect(snapToCourse(course, 15)).toBe(1);
    expect(snapToCourse(course, 16)).toBe(2);
    expect(snapToCourse(course, 93)).toBe(10);
    expect(snapToCourse(course, 92)).toBe(9);
    expect(snapToCourse(course, -3)).toBe(0);
    expect(snapToCourse(course, 0)).toBe(0);
    expect(snapToCourse(course, 500)).toBe(10);
    expect(() => snapToCourse({ points: [] }, 1)).toThrow(/no points/);
  });

  it("gives the bounds of a partition", () => {
    expect(partitionBounds(course, [52, 21, 19, 0, 95])).toEqual([0, 2, 5, 10]);
    expect(partitionBounds(course, [])).toEqual([0, 10]);
  });

  it("puts splits short of the finish", () => {
    expect(splitBreakpointsM(3000, 1000)).toEqual([1000, 2000]);
    expect(splitBreakpointsM(3001, 1000)).toEqual([1000, 2000, 3000]);
    expect(splitBreakpointsM(500, 1000)).toEqual([]);
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
