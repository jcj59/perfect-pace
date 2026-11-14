import { describe, expect, it } from "vitest";
import {
  MAX_ABS_GRADE,
  computeGrades,
  elevationStats,
  gainLoss,
  gaussianSmooth,
  medianFilter,
  smoothElevations,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";

const range = (n: number, step = 10): number[] => Array.from({ length: n }, (_, i) => i * step);

/** Standard normal samples (Box-Muller) from a seeded generator. */
function gaussian(next: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

/** A raised-cosine hill of `heightM` from `startM` to `endM` (up then down). */
const hill = (d: number, startM: number, endM: number, heightM: number): number =>
  d <= startM || d >= endM ? 0 : (heightM * (1 - Math.cos((2 * Math.PI * (d - startM)) / (endM - startM)))) / 2;

/**
 * A 6 km synthetic course at 10 m spacing: a 40 m hill over 1 km, a 25 m hill over 600 m, and a
 * 30 m climb to the finish over the last 1.5 km, from a base of 100 m: gain is 95 m and loss
 * 65 m exactly, and the top is 140 m.
 */
function knownProfile(): { distM: number[]; eleM: number[]; gainM: number; lossM: number } {
  const distM = range(601);
  const eleM = distM.map(
    (d) =>
      100 +
      hill(d, 1000, 2000, 40) +
      hill(d, 3000, 3600, 25) +
      (d > 4500 ? (30 * (1 - Math.cos((Math.PI * (d - 4500)) / 1500))) / 2 : 0),
  );
  return { distM, eleM, gainM: 95, lossM: 65 };
}

/** GPS-like corruption: Gaussian jitter of `sigmaM` plus isolated spikes (one or two points, 15 to 50 m). */
function corrupt(eleM: number[], seed: number, sigmaM: number, spikeChance: number): number[] {
  const next = mulberry32(seed);
  const normal = gaussian(next);
  const out = eleM.map((e) => e + sigmaM * normal());
  // Spikes stay off the first and last few points: there the window is one-sided, and a median
  // cannot tell two bad points at the very end from a real step.
  for (let i = 3; i < out.length - 5; i++) {
    if (next() < spikeChance) {
      const spike = (next() < 0.5 ? -1 : 1) * (15 + 35 * next());
      const width = next() < 0.5 ? 1 : 2;
      for (let j = i; j < Math.min(out.length, i + width); j++) out[j] = (out[j] as number) + spike;
      i += width + 3;
    }
  }
  return out;
}

describe("medianFilter", () => {
  it("removes isolated spikes and keeps ramps", () => {
    const distM = range(11);
    const ramp = distM.map((d) => d / 10);
    const spiky = [...ramp];
    spiky[3] = -400;
    spiky[6] = 500;
    spiky[7] = 500;
    const out = medianFilter(distM, spiky, 50);
    expect(out[3]).toBe(2);
    // Two adjacent spikes in a five-point window: the median falls on a neighbor, never a spike.
    expect(Math.abs((out[6] as number) - 6)).toBeLessThanOrEqual(2);
    expect(Math.abs((out[7] as number) - 7)).toBeLessThanOrEqual(2);
    expect(medianFilter(distM, ramp, 50).slice(2, 9)).toEqual(ramp.slice(2, 9));
  });

  it("averages the middle two of an even window, and a zero window is the identity", () => {
    expect(medianFilter([0, 10], [1, 4], 20)).toEqual([2.5, 2.5]);
    expect(medianFilter([0, 10, 20], [3, 1, 2], 0)).toEqual([3, 1, 2]);
  });

  it("works on uneven spacing", () => {
    expect(medianFilter([0, 1, 2, 100], [0, 9, 3, 50], 2)).toEqual([4.5, 3, 6, 50]);
  });

  it("validates its input", () => {
    expect(() => medianFilter([0, 10], [1], 50)).toThrow(RangeError);
    expect(() => medianFilter([0, 10], [1, Number.NaN], 50)).toThrow(/point 1/);
    expect(() => medianFilter([10, 0], [1, 2], 50)).toThrow(/decreasing/);
    expect(() => medianFilter([0, 10], [1, 2], -1)).toThrow(/windowM/);
  });
});

describe("gaussianSmooth", () => {
  it("keeps constants and straight lines (away from the ends)", () => {
    const distM = range(101);
    expect(
      gaussianSmooth(
        distM,
        distM.map(() => 7),
        30,
      ).every((e) => Math.abs(e - 7) < 1e-9),
    ).toBe(true);
    const line = distM.map((d) => 0.05 * d);
    const out = gaussianSmooth(distM, line, 30);
    for (let i = 10; i <= 90; i++) expect(out[i]).toBeCloseTo(line[i] as number, 9);
  });

  it("is the identity at sigma 0 and handles empty input", () => {
    expect(gaussianSmooth([0, 10], [1, 5], 0)).toEqual([1, 5]);
    expect(gaussianSmooth([], [], 30)).toEqual([]);
  });

  it("flattens short bumps much more than long hills", () => {
    const distM = range(401);
    const short = gaussianSmooth(
      distM,
      distM.map((d) => hill(d, 1950, 2050, 10)),
      30,
    );
    const long = gaussianSmooth(
      distM,
      distM.map((d) => hill(d, 1500, 2500, 10)),
      30,
    );
    expect(Math.max(...short)).toBeLessThan(6);
    expect(Math.max(...long)).toBeGreaterThan(9.8);
  });
});

describe("computeGrades", () => {
  it("is rise over run per interval, clamped, with 0 for zero-length intervals", () => {
    expect(computeGrades([0, 100, 100, 110, 120], [0, 5, 9, 19, 9])).toEqual([0.05, 0, MAX_ABS_GRADE, -MAX_ABS_GRADE]);
    expect(computeGrades([0, 10], [0, 10], 1)).toEqual([1]);
    expect(computeGrades([0], [5])).toEqual([]);
    expect(() => computeGrades([0, 10], [0, 1], -0.1)).toThrow(RangeError);
  });
});

describe("gainLoss", () => {
  it("ignores wiggles under the threshold", () => {
    const saw = range(200).map((_, i) => 100 + (i % 2) * 1.9);
    expect(gainLoss(saw, 2)).toEqual({ gainM: 0, lossM: 0 });
  });

  it("counts real climbs in full, from exact bottom to exact top", () => {
    // A dead band of 5 m would count this 12 m hill as 10 m.
    expect(gainLoss([0, 3, 6, 9, 12, 8, 4, 0], 5)).toEqual({ gainM: 12, lossM: 12 });
    expect(gainLoss([10, 9, 12, 20, 19.5, 30, 25, 26, 5], 2)).toEqual({ gainM: 21, lossM: 25 });
  });

  it("measures the first climb from the lowest point of a small opening dip", () => {
    expect(gainLoss([100, 99, 98.5, 105, 110], 2)).toEqual({ gainM: 11.5, lossM: 0 });
    expect(gainLoss([100, 101, 101.5, 95, 90], 2)).toEqual({ gainM: 0, lossM: 11.5 });
  });

  it("counts the leg in progress at the end", () => {
    expect(gainLoss([0, 10, 0, 3], 2)).toEqual({ gainM: 13, lossM: 10 });
    expect(gainLoss([0, 10, 0, 1], 2)).toEqual({ gainM: 10, lossM: 10 });
  });

  it("sums every positive and negative step at threshold 0", () => {
    expect(gainLoss([0, 1, 1, 0.5, 2, 2], 0)).toEqual({ gainM: 2.5, lossM: 0.5 });
  });

  it("handles empty, single and flat profiles, and rejects bad input", () => {
    expect(gainLoss([])).toEqual({ gainM: 0, lossM: 0 });
    expect(gainLoss([5])).toEqual({ gainM: 0, lossM: 0 });
    expect(gainLoss([5, 5, 5])).toEqual({ gainM: 0, lossM: 0 });
    expect(() => gainLoss([1, Number.POSITIVE_INFINITY])).toThrow(/point 1/);
    expect(() => gainLoss([1, 2], Number.NaN)).toThrow(/thresholdM/);
  });

  it("keeps gain minus loss within two thresholds of the net change (seeded random walks)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const next = mulberry32(seed);
      let e = 100;
      const walk = range(500).map(() => (e += (next() - 0.5) * 6));
      const { gainM, lossM } = gainLoss(walk, 3);
      const net = (walk.at(-1) as number) - (walk[0] as number);
      expect(Math.abs(gainM - lossM - net), `seed ${seed}`).toBeLessThan(6 + 1e-9);
      expect(gainM, `seed ${seed}`).toBeLessThanOrEqual(gainLoss(walk, 0).gainM + 1e-9);
    }
  });
});

describe("elevationStats", () => {
  it("adds the minimum and maximum", () => {
    expect(elevationStats([3, 10, -2, 4], 1)).toEqual({ gainM: 13, lossM: 12, minM: -2, maxM: 10 });
    expect(() => elevationStats([])).toThrow(RangeError);
  });
});

describe("synthetic profiles (B3)", () => {
  it("recover the known gain and loss within 5% through noise and spikes", () => {
    const { distM, eleM, gainM, lossM } = knownProfile();
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const noisy = corrupt(eleM, seed, 1.5, 0.01);
      const smoothed = smoothElevations(distM, noisy);
      const stats = elevationStats(smoothed);
      expect(Math.abs(stats.gainM - gainM), `seed ${seed}: gain ${stats.gainM}`).toBeLessThan(0.05 * gainM);
      expect(Math.abs(stats.lossM - lossM), `seed ${seed}: loss ${stats.lossM}`).toBeLessThan(0.05 * lossM);
      expect(Math.abs(stats.maxM - 140), `seed ${seed}: max ${stats.maxM}`).toBeLessThan(2);
      // Without the pipeline, the same noise counts several times the real climbing.
      expect(gainLoss(noisy, 0).gainM, `seed ${seed}`).toBeGreaterThan(5 * gainM);
    }
  });

  it("recover a clean profile almost exactly", () => {
    const { distM, eleM, gainM, lossM } = knownProfile();
    const stats = elevationStats(smoothElevations(distM, eleM));
    expect(Math.abs(stats.gainM - gainM)).toBeLessThan(0.02 * gainM);
    expect(Math.abs(stats.lossM - lossM)).toBeLessThan(0.02 * lossM);
  });

  it("find almost no climbing on a flat 10 km course with GPS jitter", () => {
    const distM = range(1001);
    const seeds = [21, 22, 23, 24, 25, 26, 27, 28];
    const totals = seeds.map((seed) => {
      const noisy = corrupt(
        distM.map(() => 50),
        seed,
        1.5,
        0.01,
      );
      // Raw, the jitter alone adds up to well over a kilometer of climbing and descending.
      const raw = gainLoss(noisy, 0);
      expect(raw.gainM + raw.lossM, `seed ${seed}`).toBeGreaterThan(1000);
      const { gainM, lossM } = elevationStats(smoothElevations(distM, noisy));
      return gainM + lossM;
    });
    expect(Math.max(...totals), totals.join(", ")).toBeLessThan(12);
    expect(totals.reduce((a, b) => a + b, 0) / totals.length, totals.join(", ")).toBeLessThan(6);
  });

  it("keep the grade of a long steady climb", () => {
    const distM = range(301);
    const noisy = corrupt(
      distM.map((d) => 0.06 * d),
      31,
      1,
      0,
    );
    const grades = computeGrades(distM, smoothElevations(distM, noisy));
    const middle = grades.slice(50, 250);
    expect(middle.reduce((a, b) => a + b, 0) / middle.length).toBeCloseTo(0.06, 3);
    expect(Math.max(...middle.map((g) => Math.abs(g - 0.06)))).toBeLessThan(0.02);
  });
});
