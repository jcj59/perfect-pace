import { readFileSync } from "node:fs";
import {
  type ElevationProfile,
  type ErrorCurvePoint,
  METERS_PER_MILE,
  type Plan,
  buildCourse,
  computePlan,
} from "@pp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { curveKnee, curvePoints } from "../src/plan/curve.ts";
import {
  checkGoal,
  defaultMinSegmentM,
  minSegmentOptions,
  roundPreservingSum,
  snapMinSegmentM,
  suggestedGoalS,
} from "../src/plan/inputs.ts";
import { TONES, TONE_COLORS, TONE_STEPS_S_PER_MI, segmentTone, toneVar } from "../src/plan/tones.ts";
import { planFeatures } from "../src/map/course-layer.ts";
import { type AppState, type CourseState, initialAppState } from "../src/state/app.ts";
import { type PlanView, planErrorMessage, startPlanner } from "../src/state/plan.ts";
import { createStore } from "../src/state/store.ts";

const MARATHON_M = 42_195;

describe("suggestedGoalS", () => {
  it("is a 9:00 per mile effort, rounded to 5 minutes from an hour up and to the minute below", () => {
    expect(suggestedGoalS(MARATHON_M)).toBe(3 * 3600 + 55 * 60); // 3:55:57 rounds to 3:55:00
    expect(suggestedGoalS(5000)).toBe(28 * 60); // 27:58
    expect(suggestedGoalS(10)).toBe(60); // never zero
  });
});

describe("checkGoal", () => {
  it("accepts h:mm:ss and m:ss", () => {
    expect(checkGoal("3:00:00", MARATHON_M, "mi")).toEqual({ ok: true, seconds: 10_800 });
    expect(checkGoal(" 25:00 ", 5000, "km")).toEqual({ ok: true, seconds: 1500 });
  });

  it("explains an empty or malformed goal", () => {
    expect(checkGoal("", MARATHON_M, "mi")).toEqual({ ok: false, message: "Enter a goal time, like 3:30:00." });
    for (const text of ["3h", "3:0:00", "3:00:60", "abc", "-1:00:00"]) {
      const check = checkGoal(text, MARATHON_M, "mi");
      expect(check.ok, text).toBe(false);
      if (!check.ok) expect(check.message).toMatch(/like 3:30:00/);
    }
  });

  it("rejects an impossibly fast goal and offers the hours reading of a short one", () => {
    const check = checkGoal("3:30", MARATHON_M, "mi");
    expect(check).toEqual({
      ok: false,
      message: "That is 0:08 per mi, faster than anyone runs. Did you mean 3:30:00?",
    });
    const zero = checkGoal("0:00", MARATHON_M, "km");
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.message).toMatch(/^That is no time at all/);
    // A 1:00:00 marathon is too fast either way, so no suggestion.
    const hour = checkGoal("1:00:00", MARATHON_M, "mi");
    expect(hour.ok).toBe(false);
    if (!hour.ok) expect(hour.message).not.toMatch(/Did you mean/);
  });

  it("rejects a goal slower than an hour per mile, saying the longest it takes", () => {
    const check = checkGoal("30:00:00", MARATHON_M, "km");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toBe("That is slower than 37:17 per km. Enter a goal up to 26:13:07.");
  });
});

describe("shortest segment choices", () => {
  it("offers no minimum and a few distances per unit system", () => {
    expect(minSegmentOptions("mi").map((o) => o.label)).toEqual(["No minimum", "0.1 mi", "0.25 mi", "0.5 mi", "1 mi"]);
    expect(minSegmentOptions("km").map((o) => o.meters)).toEqual([0, 200, 500, 1000, 2000]);
  });

  it("defaults to a quarter mile or half a kilometer, both among the choices", () => {
    for (const unit of ["mi", "km"] as const) {
      expect(minSegmentOptions(unit).map((o) => o.meters)).toContain(defaultMinSegmentM(unit));
    }
  });

  it("snaps to the nearest choice in the other units", () => {
    expect(snapMinSegmentM(0, "km")).toBe(0);
    expect(snapMinSegmentM(0.25 * METERS_PER_MILE, "km")).toBe(500);
    expect(snapMinSegmentM(500, "mi")).toBeCloseTo(0.25 * METERS_PER_MILE);
    expect(snapMinSegmentM(1000, "mi")).toBeCloseTo(0.5 * METERS_PER_MILE);
    expect(snapMinSegmentM(2000, "mi")).toBeCloseTo(METERS_PER_MILE);
    expect(snapMinSegmentM(200, "mi")).toBeCloseTo(0.1 * METERS_PER_MILE);
  });
});

describe("roundPreservingSum", () => {
  it("rounds each value so the parts add up to the rounded total", () => {
    const values = [600.4, 600.4, 600.4, 600.4, 600.4]; // each rounds down, the total is 3002
    const rounded = roundPreservingSum(values);
    expect(rounded.reduce((a, b) => a + b, 0)).toBe(3002);
    expect(rounded).toEqual([601, 601, 600, 600, 600]);
    expect(roundPreservingSum([1.5, 2.5])).toEqual([2, 2]);
    expect(roundPreservingSum([])).toEqual([]);
  });

  it("keeps a real plan's segment times adding up to its goal", () => {
    const points = Array.from({ length: 400 }, (_, i) => ({
      lat: 42 + i * 0.001,
      lon: -71,
      ele: 50 + 30 * Math.sin(i / 20),
    }));
    const plan = computePlan(buildCourse(points), { goalTimeS: 10_800, paceChanges: 6, unit: "mi" });
    const times = roundPreservingSum(plan.segments.map((s) => s.timeS));
    expect(times.reduce((a, b) => a + b, 0)).toBe(10_800);
    times.forEach((t, i) => expect(Math.abs(t - plan.segments[i]!.timeS)).toBeLessThan(1));
  });
});

describe("segment tones", () => {
  const flat = 400 / METERS_PER_MILE;
  const at = (deltaSPerMi: number) => segmentTone(flat + deltaSPerMi / METERS_PER_MILE, flat);

  it("steps away from flat pace, slower positive and faster negative", () => {
    expect(at(0)).toBe(0);
    expect(at(3.9)).toBe(0);
    expect(at(-3.9)).toBe(0);
    expect(at(TONE_STEPS_S_PER_MI[0])).toBe(1);
    expect(at(12)).toBe(2); // a 1% climb under Daniels
    expect(at(-7)).toBe(-1); // a 1% descent
    expect(at(25)).toBe(3);
    expect(at(-40)).toBe(-3);
  });

  it("has the same colors in styles.css as in the map's table", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const [light, dark] = [css.slice(css.indexOf(":root {")), css.slice(css.indexOf(".dark {"))];
    for (const tone of TONES) {
      const name = toneVar(tone).slice(4, -1);
      const value = (block: string) => new RegExp(`${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
      expect(value(light), `${name} light`).toBe(TONE_COLORS.light[tone]);
      expect(value(dark), `${name} dark`).toBe(TONE_COLORS.dark[tone]);
    }
  });
});

describe("error curve", () => {
  const curve = (gaps: number[]): ErrorCurvePoint[] =>
    gaps.map((g, k) => ({ paceChanges: k, segments: k + 1, error: g * g, rmsPaceGapSPerM: g }));

  it("finds where most of the improvement is in", () => {
    expect(curveKnee(curve([10, 5, 3, 2, 1.5, 1.2, 1]))).toBe(4); // 90% of the 9 s gain is in by 1.9 s
    expect(curveKnee(curve([10, 1, 1, 1]))).toBe(1);
    expect(curveKnee(curve([2, 2, 2]))).toBe(0);
    expect(curveKnee([])).toBe(0);
  });

  it("places each point over the slider thumb's center for its value", () => {
    const points = curvePoints(curve([10, 5, 0]), 222, 60, 11, 10);
    expect(points.map((p) => p.x)).toEqual([11, 111, 211]);
    expect(points.map((p) => p.y)).toEqual([10, 35, 60]);
    expect(curvePoints(curve([0, 0]), 100, 40, 11).map((p) => p.y)).toEqual([40, 40]);
  });
});

describe("map segments", () => {
  it("draws each segment, with a break dot where each later one starts", () => {
    const points = buildCourse(
      Array.from({ length: 30 }, (_, i) => ({ lat: 42 + i * 0.001, lon: -71 + (i % 2) * 0.0005, ele: 10 })),
    ).points;
    const data = planFeatures([
      { points: points.slice(0, 11), tone: -1 },
      { points: points.slice(10, 21), tone: 2 },
      { points: points.slice(20), tone: 0 },
    ]);
    expect(data.features.map((f) => f.properties.role)).toEqual(["segment", "segment", "segment", "break", "break"]);
    expect(data.features[1]!.properties).toEqual({ role: "segment", index: 1, tone: 2 });
    expect(planFeatures(null).features).toEqual([]);
    expect(planFeatures([]).features).toEqual([]);
  });
});

describe("planErrorMessage", () => {
  it("explains a goal too fast for the descents", () => {
    expect(planErrorMessage(new Error("idealPaces: the goal of 60 s is too fast for this course's descents"))).toMatch(
      /too fast for the course's steepest descents/,
    );
    expect(planErrorMessage("boom")).toMatch(/could not be worked out/);
  });
});

describe("startPlanner", () => {
  const profile = (lengthM: number) =>
    ({ course: { points: [{ distM: 0 }, { distM: lengthM }] } }) as unknown as ElevationProfile;
  const loaded = (p: ElevationProfile): CourseState =>
    ({
      status: "loaded",
      fileName: "a.gpx",
      file: { tracks: [], defaultTrack: 0 },
      track: 0,
      elevation: { status: "ready", profile: p },
    }) as unknown as CourseState;
  const fakePlan = (goalTimeS: number, starts: number[]) =>
    ({ goalTimeS, segments: starts.map((startIndex) => ({ startIndex })) }) as unknown as Plan;

  let store: ReturnType<typeof createStore<AppState>>;
  let plans: ReturnType<typeof createStore<PlanView>>;
  let calls: { inputs: { goalTimeS: number; paceChanges: number }; signal: AbortSignal; resolve: (p: Plan) => void }[];
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStore(initialAppState(undefined, "en-US"));
    plans = createStore<PlanView>({ profile: null, plan: null, error: null, pending: false });
    calls = [];
    stop = startPlanner({
      store,
      plans,
      debounceMs: 100,
      call: (input, { signal }) =>
        new Promise<Plan>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          calls.push({ inputs: input.inputs, signal: signal!, resolve });
        }),
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("asks for a new course's plan right away, at the suggested goal", () => {
    const p = profile(MARATHON_M);
    store.set({ course: loaded(p) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inputs.goalTimeS).toBe(suggestedGoalS(MARATHON_M));
    expect(plans.get()).toMatchObject({ profile: p, plan: null, pending: true });
    calls[0]!.resolve(fakePlan(1, [0]));
  });

  it("debounces input changes, aborts stale requests and keeps the old plan up while pending", async () => {
    const p = profile(MARATHON_M);
    store.set({ course: loaded(p) });
    const first = fakePlan(14_100, [0, 5]);
    calls[0]!.resolve(first);
    await vi.waitFor(() => expect(plans.get().plan).toBe(first));
    expect(plans.get().pending).toBe(false);

    store.set({ goalTimeS: 10_800 });
    store.set({ paceChanges: 6 });
    expect(plans.get()).toMatchObject({ plan: first, pending: true });
    vi.advanceTimersByTime(99);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.inputs).toMatchObject({ goalTimeS: 10_800, paceChanges: 6 });

    // A change while that request runs aborts it.
    store.set({ paceChanges: 7 });
    vi.advanceTimersByTime(100);
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(calls).toHaveLength(3);
    calls[1]!.resolve(fakePlan(0, [9])); // too late: dropped
    const latest = fakePlan(10_800, [0, 3, 6]);
    calls[2]!.resolve(latest);
    await vi.waitFor(() => expect(plans.get().plan).toBe(latest));
    expect(plans.get().pending).toBe(false);
  });

  it("ignores changes that leave the inputs as they were", () => {
    store.set({ course: loaded(profile(5000)) });
    store.set({ focusDistM: 100, sheet: "full" });
    vi.advanceTimersByTime(500);
    expect(calls).toHaveLength(1);
  });

  it("clears the selection when the segments move, and keeps it when they do not", async () => {
    store.set({ course: loaded(profile(MARATHON_M)) });
    calls[0]!.resolve(fakePlan(1, [0, 5, 9]));
    await vi.waitFor(() => expect(plans.get().pending).toBe(false));
    store.set({ selectedSegment: 1, units: "km" });
    vi.advanceTimersByTime(100);
    calls[1]!.resolve(fakePlan(1, [0, 5, 9]));
    await vi.waitFor(() => expect(plans.get().pending).toBe(false));
    expect(store.get().selectedSegment).toBe(1);
    store.set({ paceChanges: 1 });
    vi.advanceTimersByTime(100);
    calls[2]!.resolve(fakePlan(1, [0, 7]));
    await vi.waitFor(() => expect(plans.get().pending).toBe(false));
    expect(store.get().selectedSegment).toBeNull();
  });

  it("drops the plan when the course goes away", () => {
    store.set({ course: loaded(profile(5000)) });
    store.set({ course: { status: "empty" } });
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(plans.get()).toEqual({ profile: null, plan: null, error: null, pending: false });
  });
});
