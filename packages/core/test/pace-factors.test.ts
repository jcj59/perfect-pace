import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Course,
  DEFAULT_PACE_FACTORS,
  FACTOR_ARRIVAL_TOLERANCE_S,
  MAX_ABS_GRADE,
  MAX_FACTOR_ROUNDS,
  METERS_PER_MILE,
  PACE_FACTOR_IDS,
  PLAN_TYPES,
  type PaceFactor,
  type PaceFactorContext,
  type Plan,
  type PlanInputs,
  type PlanType,
  buildElevationProfile,
  computeGrades,
  computePlan,
  danielsAdjustment,
  neutralAltitudeFactor,
  neutralPaceFactor,
  neutralSurfaceFactor,
  neutralWeatherFactor,
  parseGpx,
  replacePaceFactor,
} from "../src/index.ts";
import { fixtureDemProvider } from "./support/dem.ts";
import { mulberry32 } from "./support/rng.ts";

/** A course heading due east from (42, -76) at `spacingM`, with elevation `eleAt(distance)`. */
function eastCourse(lengthM: number, eleAt: (d: number) => number, spacingM = 10): Course {
  const count = Math.ceil(lengthM / spacingM) + 1;
  const metersPerDegLon = 111_195 * Math.cos((42 * Math.PI) / 180);
  return {
    points: Array.from({ length: count }, (_, i) => {
      const distM = Math.min(lengthM, i * spacingM);
      return { lat: 42, lon: -76 + distM / metersPerDegLon, ele: eleAt(distM), distM };
    }),
  };
}

/** A hilly marathon at 10 m, like the perf harness's. */
const marathon = eastCourse(42_195, (d) => 100 + 25 * Math.sin(d / 2300) + 8 * Math.sin(d / 610));
const marathonGoalS = 3.5 * 3600;

/** A static factor from a function of the interval's start distance. */
function staticFactor(id: string, at: (startM: number) => number): PaceFactor {
  return {
    id,
    label: id,
    timeDependent: false,
    multipliers: (ctx) => Float64Array.from(ctx.lengthsM, (_, i) => at(ctx.distM[i]!)),
  };
}

/** A time-dependent "heat" factor: `ratePerHour` slower for every hour since the start. */
function heatFactor(ratePerHour: number, id = "weather"): PaceFactor {
  return {
    id,
    label: "Heat",
    timeDependent: true,
    multipliers: (ctx) =>
      Float64Array.from(ctx.lengthsM, (_, i) => 1 + (ratePerHour * (ctx.arrivalS[i]! + ctx.arrivalS[i + 1]!)) / 7200),
  };
}

const typeInputs = (type: PlanType, goalTimeS: number, lengthM: number): PlanInputs => ({
  goalTimeS,
  paceChanges: 5,
  unit: "mi",
  minSegmentM: 300,
  type,
  splitM: METERS_PER_MILE,
  breakpointsM: [0.2, 0.45, 0.8].map((f) => f * lengthM),
});

/** Seconds after the start of every point, following the plan's segments. */
function planArrivals(course: Course, plan: Plan): number[] {
  const out = [0];
  for (const s of plan.segments) {
    for (let i = s.startIndex; i < s.endIndex; i++) {
      const w = course.points[i + 1]!.distM - course.points[i]!.distM;
      out.push(out[i]! + w * s.paceSPerM);
    }
  }
  return out;
}

/** The grade adjustment `g_i` of every interval, as the plan computes it. */
function gradeAdjustments(course: Course): number[] {
  const grades = computeGrades(
    course.points.map((p) => p.distM),
    course.points.map((p) => p.ele!),
    MAX_ABS_GRADE,
  );
  return grades.map(danielsAdjustment);
}

function lengths(course: Course): number[] {
  return course.points.slice(1).map((p, i) => p.distM - course.points[i]!.distM);
}

const idealTime = (course: Course, plan: Plan) =>
  lengths(course).reduce((s, w, i) => s + w * plan.idealPacesSPerM[i]!, 0);

/** Without the factor summary, which is the only thing a neutral factor may add. */
function withoutSummary(plan: Plan): Omit<Plan, "paceFactors"> {
  const rest: Partial<Plan> = { ...plan };
  delete rest.paceFactors;
  return rest as Omit<Plan, "paceFactors">;
}

describe("the factor registry", () => {
  it("registers neutral weather, surface and altitude factors by default", () => {
    expect(DEFAULT_PACE_FACTORS.map((f) => f.id)).toEqual([...PACE_FACTOR_IDS]);
    expect(DEFAULT_PACE_FACTORS).toEqual([neutralWeatherFactor, neutralSurfaceFactor, neutralAltitudeFactor]);
    expect(neutralWeatherFactor.timeDependent).toBe(true);
    expect(neutralSurfaceFactor.timeDependent).toBe(false);
    expect(neutralAltitudeFactor.timeDependent).toBe(false);
  });

  it("replaces a factor by id, or appends a new one", () => {
    const heat = heatFactor(0.01);
    const replaced = replacePaceFactor(DEFAULT_PACE_FACTORS, heat);
    expect(replaced.map((f) => f.id)).toEqual(["weather", "surface", "altitude"]);
    expect(replaced[0]).toBe(heat);
    expect(DEFAULT_PACE_FACTORS[0]).toBe(neutralWeatherFactor);
    const wind = neutralPaceFactor("wind", "Wind", true);
    expect(replacePaceFactor(DEFAULT_PACE_FACTORS, wind).at(-1)).toBe(wind);
  });
});

describe("neutral factors", () => {
  const plan = (type: PlanType, factors?: readonly PaceFactor[]) =>
    computePlan(marathon, { ...typeInputs(type, marathonGoalS, 42_195), factors });

  it.each(PLAN_TYPES)("leave a %s plan identical to the bit, in one round", (type) => {
    const none = plan(type, []);
    const neutral = plan(type);
    // toStrictEqual compares numbers with Object.is: every pace, time and error is the same double.
    expect(withoutSummary(neutral)).toStrictEqual(withoutSummary(none));
    expect(neutral.paceFactors).toEqual({
      rounds: 1,
      converged: true,
      arrivalShiftS: 0,
      timeS: 0,
      effects: DEFAULT_PACE_FACTORS.map((f) => ({
        id: f.id,
        label: f.label,
        timeDependent: f.timeDependent,
        timeS: 0,
      })),
    });
    expect(none.paceFactors).toEqual({ rounds: 1, converged: true, arrivalShiftS: 0, timeS: 0, effects: [] });
  });

  it("leave a real course's plans identical too (Boston, every type and unit)", async () => {
    const gpx = parseGpx(readFileSync(join(import.meta.dirname, "fixtures", "gpx", "boston.gpx"), "utf8"));
    const profile = await buildElevationProfile(gpx.tracks[gpx.defaultTrack]!.course, {
      provider: fixtureDemProvider(),
    });
    const lengthM = profile.course.points.at(-1)!.distM;
    for (const type of PLAN_TYPES) {
      for (const unit of ["mi", "km"] as const) {
        const inputs = { ...typeInputs(type, 3 * 3600, lengthM), unit };
        const ones = [neutralPaceFactor("a", "A", true), neutralPaceFactor("b", "B", false)];
        const none = computePlan(profile.course, { ...inputs, factors: [] });
        expect(withoutSummary(computePlan(profile.course, inputs))).toStrictEqual(withoutSummary(none));
        expect(withoutSummary(computePlan(profile.course, { ...inputs, factors: ones }))).toStrictEqual(
          withoutSummary(none),
        );
      }
    }
  });
});

describe("a non-neutral factor", () => {
  // 6% slower over the second half (say, a gravel section), 2% faster over the first 5 km.
  const surface = staticFactor("surface", (d) => (d >= 21_000 ? 1.06 : d < 5000 ? 0.98 : 1));

  it.each(PLAN_TYPES)("still makes a %s plan hit the goal within 1 s", (type) => {
    const plan = computePlan(marathon, { ...typeInputs(type, marathonGoalS, 42_195), factors: [surface] });
    expect(plan.type).toBe(type);
    expect(Math.abs(plan.totalTimeS - marathonGoalS)).toBeLessThan(1);
    expect(idealTime(marathon, plan)).toBeCloseTo(marathonGoalS, 6);
    expect(plan.paceFactors.rounds).toBe(1);
  });

  it("gives every plan type the same ideal paces, of the form (b + g_i) * m_i", () => {
    const plans = PLAN_TYPES.map((type) =>
      computePlan(marathon, { ...typeInputs(type, marathonGoalS, 42_195), factors: [surface] }),
    );
    for (const p of plans) expect(p.idealPacesSPerM).toStrictEqual(plans[0]!.idealPacesSPerM);
    const plan = plans[0]!;
    const g = gradeAdjustments(marathon);
    const b = plan.flatPaceSPerM;
    plan.idealPacesSPerM.forEach((o, i) => {
      const m = marathon.points[i]!.distM >= 21_000 ? 1.06 : marathon.points[i]!.distM < 5000 ? 0.98 : 1;
      expect(o).toBeCloseTo((b + g[i]!) * m, 12);
    });
    // Slower conditions on half the course make the rest of it faster than without them.
    const none = computePlan(marathon, { ...typeInputs("optimal", marathonGoalS, 42_195), factors: [] });
    expect(b).toBeLessThan(none.flatPaceSPerM);
  });

  it("reports what it costs at the same effort", () => {
    const plan = computePlan(marathon, { ...typeInputs("optimal", marathonGoalS, 42_195), factors: [surface] });
    const g = gradeAdjustments(marathon);
    const atSameEffort = lengths(marathon).reduce((s, w, i) => s + w * (plan.flatPaceSPerM + g[i]!), 0);
    const [effect] = plan.paceFactors.effects;
    expect(effect).toMatchObject({ id: "surface", label: "surface", timeDependent: false });
    // One factor: its effect is the whole effect, the goal minus the factor-free time at this base pace.
    expect(effect!.timeS).toBeCloseTo(marathonGoalS - atSameEffort, 6);
    expect(plan.paceFactors.timeS).toBeCloseTo(effect!.timeS, 9);
    // 6% over half and -2% over 5 km of a 3:30 marathon is roughly 6 minutes slower.
    expect(effect!.timeS).toBeGreaterThan(300);
    expect(effect!.timeS).toBeLessThan(420);
  });

  it("splits the cost between factors, up to their interaction", () => {
    const altitude = staticFactor("altitude", (d) => 1.01 + 0.02 * Math.sin(d / 5000));
    const plan = computePlan(marathon, {
      ...typeInputs("even", marathonGoalS, 42_195),
      factors: [neutralWeatherFactor, surface, altitude],
    });
    const [weather, s, a] = plan.paceFactors.effects;
    expect(weather!.timeS).toBe(0);
    expect(s!.timeS).toBeGreaterThan(0);
    expect(a!.timeS).toBeGreaterThan(0);
    // 1 - 1/(fg) = (1 - 1/f) + (1 - 1/g) - (1 - 1/f)(1 - 1/g), interval by interval.
    const interaction = lengths(marathon).reduce((sum, w, i) => {
      const d = marathon.points[i]!.distM;
      const f = d >= 21_000 ? 1.06 : d < 5000 ? 0.98 : 1;
      const h = 1.01 + 0.02 * Math.sin(d / 5000);
      return sum + w * plan.idealPacesSPerM[i]! * (1 - 1 / f) * (1 - 1 / h);
    }, 0);
    expect(plan.paceFactors.timeS).toBeCloseTo(s!.timeS + a!.timeS - interaction, 6);
    expect(Math.abs(interaction)).toBeLessThan(0.01 * plan.paceFactors.timeS);
  });

  it("saves time when it is faster", () => {
    const tailwind = staticFactor("wind", () => 0.97);
    const plan = computePlan(marathon, { ...typeInputs("optimal", marathonGoalS, 42_195), factors: [tailwind] });
    expect(plan.paceFactors.effects[0]!.timeS).toBeCloseTo(marathonGoalS * (1 - 1 / 0.97), 6);
    expect(plan.flatPaceSPerM).toBeGreaterThan(
      computePlan(marathon, { ...typeInputs("optimal", marathonGoalS, 42_195), factors: [] }).flatPaceSPerM,
    );
  });
});

describe("the factor context", () => {
  it("carries per point distance, elevation and arrival times, and per interval grade and bearing", () => {
    const seen: PaceFactorContext[] = [];
    const spy = (timeDependent: boolean): PaceFactor => ({
      id: `spy-${timeDependent}`,
      label: "Spy",
      timeDependent,
      multipliers: (ctx) => {
        seen.push(ctx);
        return Float64Array.from(ctx.lengthsM, () => (timeDependent ? 1 + ctx.arrivalS.at(-1)! * 1e-9 : 1));
      },
    });
    const course = eastCourse(2000, (d) => (d < 1000 ? 100 + 0.02 * d : 120));
    computePlan(course, { goalTimeS: 600, paceChanges: 1, unit: "km", factors: [spy(false), spy(true)] });
    const [first] = seen;
    const n = course.points.length - 1;
    expect(first!.course).toBe(course);
    expect(first!.goalTimeS).toBe(600);
    expect(Array.from(first!.distM)).toEqual(course.points.map((p) => p.distM));
    expect(Array.from(first!.eleM)).toEqual(course.points.map((p) => p.ele));
    expect(first!.arrivalS).toHaveLength(n + 1);
    expect(first!.arrivalS[0]).toBe(0);
    expect(first!.arrivalS.at(-1)).toBeCloseTo(600, 6);
    // The first guess paces the climb slower than the flat, like the grade-adjusted ideal.
    expect(first!.arrivalS[100]! - first!.arrivalS[0]!).toBeGreaterThan(first!.arrivalS[200]! - first!.arrivalS[100]!);
    expect(first!.lengthsM).toHaveLength(n);
    expect(first!.grades[0]).toBeCloseTo(0.02, 9);
    expect(first!.grades.at(-1)).toBeCloseTo(0, 9);
    expect(first!.bearingDeg).toHaveLength(n);
    for (const deg of first!.bearingDeg) expect(deg).toBeCloseTo(90, 2);
    // The time-dependent one is sampled again at the plan's own arrival times.
    expect(seen.length).toBeGreaterThan(2);
    const later = seen.at(-1)!;
    expect(later.arrivalS).not.toBe(first!.arrivalS);
    expect(later.bearingDeg).toBe(first!.bearingDeg);
  });

  it("starts from an even pace when the goal is too fast for the descents without the factors", () => {
    // 1 km flat, then 1 km at the steepest grade the model takes. Without factors the goal needs a
    // negative pace on the descent; a factor that speeds up the flat makes it possible.
    const course = eastCourse(2000, (d) => (d <= 1000 ? 500 : 500 - MAX_ABS_GRADE * (d - 1000)));
    const descent = -danielsAdjustment(-MAX_ABS_GRADE);
    const goalTimeS = 0.75 * 1000 * descent;
    expect(() => computePlan(course, { goalTimeS, paceChanges: 1, unit: "km", factors: [] })).toThrow(RangeError);
    const seen: Float64Array[] = [];
    const fastFlat: PaceFactor = {
      id: "flat",
      label: "Flat",
      timeDependent: false,
      multipliers: (ctx) => {
        seen.push(ctx.arrivalS);
        return Float64Array.from(ctx.distM.subarray(1), (d) => (d <= 1000 ? 0.5 : 1));
      },
    };
    const plan = computePlan(course, { goalTimeS, paceChanges: 1, unit: "km", factors: [fastFlat] });
    expect(Math.abs(plan.totalTimeS - goalTimeS)).toBeLessThan(1e-6);
    expect(seen[0]![100]).toBeCloseTo(goalTimeS / 2, 6);
  });
});

describe("time-dependent factors", () => {
  it.each(PLAN_TYPES)("converge for a %s plan in a few rounds, at a fixed point", (type) => {
    const inputs = { ...typeInputs(type, marathonGoalS, 42_195), factors: [heatFactor(0.03)] };
    const plan = computePlan(marathon, inputs);
    const { rounds, converged, arrivalShiftS } = plan.paceFactors;
    expect(converged).toBe(true);
    // An even plan's arrival times are the goal's even pace whatever the conditions, so its first
    // plan is already within the tolerance; the others move with the heat and take another round.
    expect(rounds).toBeGreaterThanOrEqual(type === "even" ? 1 : 2);
    expect(rounds).toBeLessThanOrEqual(4);
    expect(arrivalShiftS).toBeLessThan(FACTOR_ARRIVAL_TOLERANCE_S);
    expect(Math.abs(plan.totalTimeS - marathonGoalS)).toBeLessThan(1);
    // Hotter later: the second half is paced slower than the first relative to the grade.
    const g = gradeAdjustments(marathon);
    const early = plan.idealPacesSPerM[100]! / (plan.flatPaceSPerM + g[100]!);
    const late = plan.idealPacesSPerM[4000]! / (plan.flatPaceSPerM + g[4000]!);
    expect(late).toBeGreaterThan(early + 0.02);
    // A fixed point: the heat sampled at this plan's own arrival times barely moves the plan.
    const arrivals = planArrivals(marathon, plan);
    const frozen: PaceFactor = {
      id: "frozen",
      label: "Frozen heat",
      timeDependent: false,
      multipliers: (ctx) =>
        Float64Array.from(ctx.lengthsM, (_, i) => 1 + (0.03 * (arrivals[i]! + arrivals[i + 1]!)) / 7200),
    };
    const again = computePlan(marathon, { ...inputs, factors: [frozen] });
    const shift = planArrivals(marathon, again).reduce((m, t, i) => Math.max(m, Math.abs(t - arrivals[i]!)), 0);
    expect(shift).toBeLessThan(FACTOR_ARRIVAL_TOLERANCE_S);
  });

  it("stop at the round cap when the arrival times never settle", () => {
    // Slows the first half when the runner reaches halfway early, speeds it up when late: each
    // plan flips the next, a two-cycle the iteration can never leave.
    const contrary: PaceFactor = {
      id: "contrary",
      label: "Contrary",
      timeDependent: true,
      multipliers: (ctx) => {
        const half = Math.floor(ctx.lengthsM.length / 2);
        const early = ctx.arrivalS[half]! < ctx.goalTimeS / 2;
        return Float64Array.from(ctx.lengthsM, (_, i) => (i < half ? (early ? 1.3 : 0.8) : 1));
      },
    };
    const flat = eastCourse(10_000, () => 100);
    // Even is the exception: one pace means its arrival times cannot move, so it cannot cycle.
    const even = computePlan(flat, { ...typeInputs("even", 2400, 10_000), factors: [contrary] });
    expect(even.paceFactors).toMatchObject({ rounds: 1, converged: true });
    for (const type of PLAN_TYPES.filter((t) => t !== "even")) {
      const plan = computePlan(flat, { ...typeInputs(type, 2400, 10_000), factors: [contrary] });
      expect(plan.paceFactors.rounds).toBe(MAX_FACTOR_ROUNDS);
      expect(plan.paceFactors.converged).toBe(false);
      expect(plan.paceFactors.arrivalShiftS).toBeGreaterThan(FACTOR_ARRIVAL_TOLERANCE_S);
      expect(Math.abs(plan.totalTimeS - 2400)).toBeLessThan(1e-6);
    }
  });

  it("stop after one plan when resampling gives the same multipliers", () => {
    // Time dependent in name, but constant: the first plan is already the fixed point.
    const constant: PaceFactor = { ...staticFactor("steady", () => 1.02), timeDependent: true };
    const plan = computePlan(marathon, { ...typeInputs("optimal", marathonGoalS, 42_195), factors: [constant] });
    expect(plan.paceFactors).toMatchObject({ rounds: 1, converged: true, arrivalShiftS: 0 });
  });
});

describe("invalid factors", () => {
  const course = eastCourse(1000, () => 100);
  const inputs: PlanInputs = { goalTimeS: 300, paceChanges: 0, unit: "km" };
  const factor = (multipliers: PaceFactor["multipliers"]): PaceFactor => ({
    id: "bad",
    label: "Bad",
    timeDependent: false,
    multipliers,
  });

  it.each([
    ["too few multipliers", () => [1, 1], /gave 2 multipliers for 100 intervals/],
    ["a zero multiplier", () => new Float64Array(100).fill(1).fill(0, 7, 8), /invalid multiplier 0 at interval 7/],
    ["a negative multiplier", () => new Float64Array(100).fill(-1), /invalid multiplier -1 at interval 0/],
    ["a NaN multiplier", () => new Float64Array(100).fill(Number.NaN), /invalid multiplier NaN/],
    ["an infinite multiplier", () => new Float64Array(100).fill(Infinity), /invalid multiplier Infinity/],
  ])("rejects %s", (_name, multipliers, message) => {
    expect(() => computePlan(course, { ...inputs, factors: [factor(multipliers)] })).toThrow(message);
  });

  it("rejects two factors with the same id", () => {
    expect(() =>
      computePlan(course, { ...inputs, factors: [neutralSurfaceFactor, neutralPaceFactor("surface", "Again", false)] }),
    ).toThrow(/two pace factors share the id surface/);
  });
});

describe("property: random courses and factors", () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => 9100 + i);
  it.each(SEEDS)("seed %i: every plan type hits the goal and the summary adds up", (seed) => {
    const next = mulberry32(seed);
    const lengthM = 3000 + next() * 40_000;
    const amp = [5 + 40 * next(), 2 + 10 * next(), next() * 4];
    const wave = [800 + 3000 * next(), 200 + 600 * next(), 50 + 150 * next()];
    const course = eastCourse(lengthM, (d) => 200 + amp.reduce((s, a, k) => s + a * Math.sin(d / wave[k]!), 0));
    const goalTimeS = (lengthM / METERS_PER_MILE) * (360 + 300 * next());
    const sAmp = 0.08 * next();
    const sWave = 500 + 5000 * next();
    const rate = (2 * next() - 1) * 0.05;
    const factors = [
      staticFactor("surface", (d) => 1 + sAmp * Math.sin(d / sWave) ** 2),
      heatFactor(rate),
      neutralAltitudeFactor,
    ];
    const msg = `seed ${seed}`;
    for (const type of PLAN_TYPES) {
      const plan = computePlan(course, { ...typeInputs(type, goalTimeS, lengthM), factors });
      expect(Math.abs(plan.totalTimeS - goalTimeS), msg).toBeLessThan(1);
      expect(Math.abs(idealTime(course, plan) - goalTimeS), msg).toBeLessThan(1e-6);
      for (const o of plan.idealPacesSPerM) expect(o, msg).toBeGreaterThan(0);
      const { rounds, converged, arrivalShiftS, timeS, effects } = plan.paceFactors;
      expect(converged, msg).toBe(true);
      expect(rounds, msg).toBeLessThanOrEqual(4);
      expect(arrivalShiftS, msg).toBeLessThan(FACTOR_ARRIVAL_TOLERANCE_S);
      expect(effects.map((e) => e.id)).toEqual(["surface", "weather", "altitude"]);
      expect(effects[2]!.timeS).toBe(0);
      // Surface only slows; heat slows when it rises and helps when it falls.
      expect(effects[0]!.timeS, msg).toBeGreaterThanOrEqual(0);
      if (Math.abs(rate) > 1e-3) expect(Math.sign(effects[1]!.timeS), msg).toBe(Math.sign(rate));
      // The combined effect is the goal minus the factor-free time at the same base pace, and the
      // parts add up to it within their interaction (second order in the factors' size).
      const g = gradeAdjustments(course);
      const atSameEffort = lengths(course).reduce((s, w, i) => s + w * (plan.flatPaceSPerM + g[i]!), 0);
      expect(timeS, msg).toBeCloseTo(goalTimeS - atSameEffort, 5);
      const parts = effects.reduce((s, e) => s + e.timeS, 0);
      expect(Math.abs(parts - timeS), msg).toBeLessThanOrEqual(goalTimeS * sAmp * 0.1 + 1e-6);
    }
  });
});
