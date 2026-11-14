import { describe, expect, it } from "vitest";
import {
  DANIELS_DOWNHILL_S_PER_MI_PER_PERCENT,
  DANIELS_UPHILL_S_PER_MI_PER_PERCENT,
  METERS_PER_MILE,
  additivePaceModel,
  danielsAdjustment,
  danielsPaceModel,
  paceToUnit,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";

const time = (lengths: ArrayLike<number>, paces: ArrayLike<number>): number =>
  Array.from(lengths).reduce((s, w, i) => s + w * (paces[i] as number), 0);

describe("danielsAdjustment", () => {
  it("is +12 s/mi per 1% uphill and -7 s/mi per 1% downhill", () => {
    expect(DANIELS_UPHILL_S_PER_MI_PER_PERCENT).toBe(12);
    expect(DANIELS_DOWNHILL_S_PER_MI_PER_PERCENT).toBe(7);
    expect(paceToUnit(danielsAdjustment(0.01), "mi")).toBeCloseTo(12, 12);
    expect(paceToUnit(danielsAdjustment(0.05), "mi")).toBeCloseTo(60, 12);
    expect(paceToUnit(danielsAdjustment(-0.01), "mi")).toBeCloseTo(-7, 12);
    expect(paceToUnit(danielsAdjustment(-0.035), "mi")).toBeCloseTo(-24.5, 12);
    expect(danielsAdjustment(0)).toBe(0);
  });
});

describe("danielsPaceModel", () => {
  it("states its assumption", () => {
    expect(danielsPaceModel.id).toBe("daniels");
    expect(danielsPaceModel.assumption).toMatch(/12 s per mile/);
    expect(danielsPaceModel.assumption).toMatch(/7 s per mile/);
  });

  it("gives the goal pace everywhere on a flat course", () => {
    const { paces, flatPaceSPerM } = danielsPaceModel.idealPaces([METERS_PER_MILE, METERS_PER_MILE], [0, 0], 960);
    expect(paceToUnit(flatPaceSPerM, "mi")).toBeCloseTo(480, 9);
    expect(Array.from(paces, (p) => paceToUnit(p, "mi"))).toEqual([expect.closeTo(480, 9), expect.closeTo(480, 9)]);
  });

  it("solves the base pace so a hill costs time on the way up and gives some back down", () => {
    // One mile at +2% and one at -2%: +24 s and -14 s around a base, which absorbs the net 10 s.
    const { paces, flatPaceSPerM } = danielsPaceModel.idealPaces(
      [METERS_PER_MILE, METERS_PER_MILE],
      [0.02, -0.02],
      960,
    );
    expect(paceToUnit(flatPaceSPerM, "mi")).toBeCloseTo(475, 9);
    expect(paceToUnit(paces[0]!, "mi")).toBeCloseTo(499, 9);
    expect(paceToUnit(paces[1]!, "mi")).toBeCloseTo(461, 9);
  });

  it("always adds up to the goal (seeded random courses)", () => {
    const seed = 2026;
    const next = mulberry32(seed);
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + Math.floor(next() * 500);
      const lengths = Array.from({ length: n }, () => (next() < 0.05 ? 0 : 1 + 20 * next()));
      lengths[0] = 10;
      const grades = Array.from({ length: n }, () => (next() - 0.5) * 0.3);
      const goal = 600 + 20_000 * next();
      const { paces } = danielsPaceModel.idealPaces(lengths, grades, goal);
      expect(time(lengths, paces), `seed ${seed} trial ${trial}`).toBeCloseTo(goal, 6);
      for (const p of paces) expect(p, `seed ${seed} trial ${trial}`).toBeGreaterThan(0);
    }
  });

  it.each([
    [[1], [0, 0], 100, /1 lengths but 2 grades/],
    [[1], [0], 0, /positive number of seconds/],
    [[1], [0], Infinity, /positive number of seconds/],
    [[-1], [0], 100, /interval 0 has invalid length/],
    [[1], [NaN], 100, /interval 0 has invalid grade/],
    [[0, 0], [0, 0], 100, /zero length/],
    // 1 km up and 1 km down at 30% in 100 s: the descent would need a negative pace.
    [[1000, 1000], [0.3, -0.3], 100, /too fast/],
  ])("rejects invalid input %#", (lengths, grades, goal, message) => {
    expect(() => danielsPaceModel.idealPaces(lengths, grades, goal)).toThrow(message);
  });
});

describe("additivePaceModel", () => {
  it("builds a model from any adjustment, still adding up to the goal", () => {
    const steep = additivePaceModel("double", "Twice Daniels.", (g) => 2 * danielsAdjustment(g));
    const lengths = [100, 200, 300];
    const grades = [0.04, 0, -0.02];
    const { paces } = steep.idealPaces(lengths, grades, 180);
    expect(time(lengths, paces)).toBeCloseTo(180, 9);
    const base = danielsPaceModel.idealPaces(lengths, grades, 180).paces;
    expect(paces[0]! - paces[1]!).toBeCloseTo(2 * (base[0]! - base[1]!), 12);
    expect(steep.id).toBe("double");
    expect(steep.assumption).toBe("Twice Daniels.");
  });
});
