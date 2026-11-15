import { type Course, MAX_CUSTOM_BREAKPOINTS, METERS_PER_MILE, computePlan } from "@pp/core";
import { describe, expect, it } from "vitest";
import {
  checkSplit,
  distanceInput,
  movedBreakpoints,
  nextBreakpointM,
  parseDistance,
  retypedBreakpoints,
  snapBreakpointM,
  withBreakpoint,
} from "../src/plan/breakpoints.ts";
import { exportCsv, paceBand, segmentBand, splitPace, splitsCsv } from "../src/plan/export.ts";
import { cleanBreakpoints } from "../src/state/app.ts";

/** A 1 km course with a point every 10 m, and a 5 m last step. */
const course: Course = {
  points: [...Array.from({ length: 100 }, (_, i) => i * 10), 995].map((distM) => ({
    lat: 42 + distM / 111_195,
    lon: -76,
    ele: 100 + 10 * Math.sin(distM / 150),
    distM,
  })),
};

describe("custom breakpoints", () => {
  it("snap to the nearest course point, never the start or the finish", () => {
    expect(snapBreakpointM(course, 123)).toBe(120);
    expect(snapBreakpointM(course, 126)).toBe(130);
    expect(snapBreakpointM(course, 4)).toBeUndefined();
    expect(snapBreakpointM(course, 993)).toBeUndefined();
  });

  it("add one in order, unless it is already there or the list is full", () => {
    expect(withBreakpoint(course, [100, 500], 302)).toEqual([100, 300, 500]);
    expect(withBreakpoint(course, [100, 500], 498)).toBeUndefined();
    expect(withBreakpoint(course, [100], 1)).toBeUndefined();
    const full = Array.from({ length: MAX_CUSTOM_BREAKPOINTS }, (_, i) => (i + 1) * 20);
    expect(withBreakpoint(course, full, 905)).toBeUndefined();
  });

  it("add one in the middle of the longest segment when no spot is picked", () => {
    expect(nextBreakpointM(course, [])).toBe(500);
    expect(nextBreakpointM(course, [500])).toBe(250);
    expect(nextBreakpointM(course, [100, 200])).toBe(600);
  });

  it("move a dragged one, snapped and kept clear of its neighbors and the ends", () => {
    expect(movedBreakpoints(course, [100, 500, 800], 1, 642)).toEqual([100, 640, 800]);
    expect(movedBreakpoints(course, [100, 500, 800], 1, 950)).toEqual([100, 790, 800]);
    expect(movedBreakpoints(course, [100, 500, 800], 1, 20)).toEqual([100, 110, 800]);
    expect(movedBreakpoints(course, [100, 500, 800], 0, -50)).toEqual([10, 500, 800]);
    expect(movedBreakpoints(course, [100, 500, 800], 2, 5000)).toEqual([100, 500, 990]);
    expect(movedBreakpoints(course, [100, 110], 0, 300)).toEqual([100, 110]);
  });

  it("retype one, merging with another it lands on", () => {
    expect(retypedBreakpoints(course, [100, 500], 0, 702)).toEqual([500, 700]);
    expect(retypedBreakpoints(course, [100, 500], 0, 501)).toEqual([500]);
    expect(retypedBreakpoints(course, [100, 500], 0, 999)).toBeUndefined();
  });

  it("are kept finite, past the start, in order, unique and within the cap", () => {
    expect(cleanBreakpoints([500, NaN, 100, 0, -3, 100, Infinity])).toEqual([100, 500]);
    expect(cleanBreakpoints(Array.from({ length: 60 }, (_, i) => i + 1))).toHaveLength(MAX_CUSTOM_BREAKPOINTS);
  });
});

describe("typed distances", () => {
  it("read decimals in the units, with a decimal point or comma", () => {
    expect(parseDistance(" 13.1 ", "mi")).toBeCloseTo(13.1 * METERS_PER_MILE, 6);
    expect(parseDistance("5,5", "km")).toBe(5500);
    expect(parseDistance(".5", "km")).toBe(500);
    expect(parseDistance("5.", "km")).toBe(5000);
    for (const bad of ["", "abc", "-1", "1e3", "1.2.3"]) expect(parseDistance(bad, "km")).toBeUndefined();
    expect(distanceInput(1609.344 * 3.104, "mi")).toBe("3.1");
    expect(distanceInput(5000, "km")).toBe("5");
  });

  it("check a split length: at least a tenth of the unit, and not too many splits", () => {
    expect(checkSplit("5", "km", 42_195)).toEqual({ ok: true, meters: 5000 });
    expect(checkSplit("0.1", "mi", 42_195)).toMatchObject({ ok: true });
    expect(checkSplit("0.05", "km", 42_195)).toEqual({ ok: false, message: "Use splits of at least 0.1 km." });
    expect(checkSplit("x", "mi", 42_195)).toMatchObject({ ok: false, message: /Enter a distance in mi/ });
    expect(checkSplit("0.1", "km", 200_000)).toMatchObject({ ok: false, message: /more than 1000 splits/ });
  });
});

describe("the Splits view and its exports", () => {
  const points = Array.from({ length: 400 }, (_, i) => ({
    lat: 42 + i * 0.001,
    lon: -71,
    ele: 50 + 30 * Math.sin(i / 20),
    distM: 0,
  }));
  let d = 0;
  points.forEach((p, i) => {
    if (i > 0) d += 111.195;
    p.distM = d;
  });
  const plan = computePlan(
    { points },
    { goalTimeS: 10_800, paceChanges: 6, unit: "mi", type: "custom", breakpointsM: [9000, 20_000] },
  );

  it("give every split its average pace from the time shown", () => {
    const rows = paceBand(plan, "km");
    expect(rows[0]).toMatchObject({ startM: 0, endM: 1000 });
    expect(splitPace(rows[0]!)).toBe(rows[0]!.exactSplitS / 1000);
    expect(Math.abs(rows[0]!.exactSplitS - rows[0]!.splitS)).toBeLessThanOrEqual(0.5);
    // An even pace reads the same every kilometer, though the rounded splits do not.
    const even = computePlan({ points }, { goalTimeS: 10_800, paceChanges: 0, unit: "km", type: "even" });
    const evenRows = paceBand(even, "km").slice(0, -1);
    expect(new Set(evenRows.map((r) => Math.round(splitPace(r) * 1000))).size).toBe(1);
    expect(rows.at(-1)!.endM).toBe(plan.lengthM);
  });

  it("export one CSV row per split, adding up to the goal", () => {
    const rows = splitsCsv(plan, "km")
      .trimEnd()
      .split("\r\n")
      .map((r) => r.split(","));
    expect(rows[0]).toEqual(["Km", "Start (km)", "End (km)", "Distance (km)", "Pace (/km)", "Split", "Elapsed"]);
    expect(rows).toHaveLength(paceBand(plan, "km").length + 1);
    expect(rows[1]!.slice(0, 4)).toEqual(["1", "0.00", "1.00", "1.00"]);
    expect(rows.at(-1)![0]).toBe("Finish");
    expect(rows.at(-1)![6]).toBe("3:00:00");
    expect(exportCsv(plan, "km", "splits")).toBe(splitsCsv(plan, "km"));
    expect(exportCsv(plan, "mi", "segments").split("\r\n")[0]).toMatch(/^Segment,/);
    expect(splitsCsv(plan, "mi").split(",")[0]).toBe("Mile");
  });

  it("band the segments with the time at each end, adding up to the goal", () => {
    const rows = segmentBand(plan);
    expect(rows.map((r) => Math.round(r.endM))).toEqual([9007, 20_015, Math.round(plan.lengthM)]);
    expect(rows.at(-1)!.elapsedS).toBe(10_800);
    expect(rows.reduce((a, r) => a + r.timeS, 0)).toBe(10_800);
  });
});
