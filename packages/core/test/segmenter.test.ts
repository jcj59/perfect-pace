import { describe, expect, it } from "vitest";
import { type Segmentation, segmentLeastSquares, segmentPartition } from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";

/** The weighted squared error of `bounds` at each piece's weighted mean, summed term by term. */
function directError(values: readonly number[], weights: readonly number[], bounds: readonly number[]): number {
  let error = 0;
  for (let p = 0; p + 1 < bounds.length; p++) {
    const a = bounds[p]!;
    const b = bounds[p + 1]!;
    let W = 0;
    let S = 0;
    for (let i = a; i < b; i++) {
      W += weights[i]!;
      S += weights[i]! * values[i]!;
    }
    const mean = W > 0 ? S / W : 0;
    for (let i = a; i < b; i++) error += weights[i]! * (values[i]! - mean) ** 2;
  }
  return error;
}

const pieceWeights = (weights: readonly number[], bounds: readonly number[]): number[] =>
  bounds.slice(1).map((b, p) => weights.slice(bounds[p], b).reduce((s, w) => s + w, 0));

/**
 * Brute force: the least error with at most `k` pieces for every `k = 1..maxPieces`, over every
 * one of the `2^(n - 1)` ways to place breakpoints, each piece at least `minW` heavy (one piece is
 * always allowed).
 */
function bruteForce(values: number[], weights: number[], maxPieces: number, minW: number): number[] {
  const n = values.length;
  const best = new Array<number>(maxPieces).fill(Infinity);
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const bounds = [0];
    for (let b = 1; b < n; b++) if (mask & (1 << (b - 1))) bounds.push(b);
    bounds.push(n);
    const pieces = bounds.length - 1;
    if (pieces > maxPieces) continue;
    if (pieces > 1 && pieceWeights(weights, bounds).some((w) => w < minW)) continue;
    const e = directError(values, weights, bounds);
    for (let k = pieces; k <= maxPieces; k++) best[k - 1] = Math.min(best[k - 1]!, e);
  }
  return best;
}

/** The textbook O(K n^2) recurrence with no pruning, for checking the pruned DP on larger inputs. */
function naiveDp(values: number[], weights: number[], maxPieces: number, minW: number): number[] {
  const n = values.length;
  const cost = (i: number, j: number) => directError(values.slice(i, j), weights.slice(i, j), [0, j - i]);
  const W = (i: number, j: number) => weights.slice(i, j).reduce((s, w) => s + w, 0);
  const costs: number[][] = [];
  for (let i = 0; i < n; i++) {
    costs[i] = [];
    for (let j = i + 1; j <= n; j++) costs[i]![j] = cost(i, j);
  }
  let prev = Array.from({ length: n + 1 }, (_, j) =>
    j === 0 ? 0 : j === n || W(0, j) >= minW ? costs[0]![j]! : Infinity,
  );
  const out = [prev[n]!];
  for (let k = 2; k <= maxPieces; k++) {
    const cur = [0];
    for (let j = 1; j <= n; j++) {
      let best = prev[j]!;
      for (let i = 1; i < j; i++) if (W(i, j) >= minW) best = Math.min(best, prev[i]! + costs[i]![j]!);
      cur.push(best);
    }
    out.push(cur[n]!);
    prev = cur;
  }
  return out;
}

/** Everything a valid result must satisfy, whatever the input. */
function checkValid(result: Segmentation[], values: number[], weights: number[], minW: number, label: string): void {
  const n = values.length;
  const scale = weights.reduce((s, w, i) => s + w * values[i]! ** 2, 0);
  const totalWO = weights.reduce((s, w, i) => s + w * values[i]!, 0);
  result.forEach((r, idx) => {
    const k = idx + 1;
    expect(r.maxPieces, label).toBe(k);
    const { bounds } = r;
    expect(bounds[0], label).toBe(0);
    expect(bounds.at(-1), label).toBe(n);
    for (let p = 1; p < bounds.length; p++) expect(bounds[p]!, label).toBeGreaterThan(bounds[p - 1]!);
    expect(bounds.length - 1, label).toBeLessThanOrEqual(k);
    expect(r.values.length, label).toBe(bounds.length - 1);
    if (bounds.length > 2) {
      for (const w of pieceWeights(weights, bounds)) expect(w, label).toBeGreaterThanOrEqual(minW - 1e-9);
    }
    expect(r.error, label).toBeCloseTo(directError(values, weights, bounds), 9);
    // The pieces' total "time" is the input's: the reason the plan meets the goal for free.
    const time = pieceWeights(weights, bounds).reduce((s, w, p) => s + w * r.values[p]!, 0);
    expect(time, label).toBeCloseTo(totalWO, 9);
    if (idx > 0) expect(r.error, label).toBeLessThanOrEqual(result[idx - 1]!.error + 1e-12 * scale);
  });
}

function expectMatches(actual: number[], expected: number[], scale: number, label: string): void {
  expect(actual.length, label).toBe(expected.length);
  actual.forEach((e, k) => {
    expect(Math.abs(e - expected[k]!), `${label}, k = ${k + 1}: ${e} vs ${expected[k]}`).toBeLessThanOrEqual(
      1e-9 * (1 + scale),
    );
  });
}

describe("segmentLeastSquares vs brute force", () => {
  it("matches on every input over a small alphabet (exhaustive)", () => {
    // Every value vector in {0, 1, 3}^n for n up to 6, unit and uneven weights, every K and two
    // minimum weights: all ties, plateaus and spikes a tiny input can have.
    for (let n = 1; n <= 6; n++) {
      for (let code = 0; code < 3 ** n; code++) {
        const values = Array.from({ length: n }, (_, i) => [0, 1, 3][Math.floor(code / 3 ** i) % 3]!);
        for (const weights of [new Array<number>(n).fill(1), values.map((_, i) => 1 + (i % 3))]) {
          for (const minW of [0, 2]) {
            const label = `values ${values.join()} weights ${weights.join()} minW ${minW}`;
            const result = segmentLeastSquares(values, weights, { maxPieces: n, minPieceWeight: minW });
            checkValid(result, values, weights, minW, label);
            const scale = weights.reduce((s, w, i) => s + w * values[i]! ** 2, 0);
            expectMatches(
              result.map((r) => r.error),
              bruteForce(values, weights, n, minW),
              scale,
              label,
            );
          }
        }
      }
    }
  });

  it("matches on seeded random inputs (randomized)", () => {
    const seed = 5999;
    const next = mulberry32(seed);
    for (let trial = 0; trial < 400; trial++) {
      const n = 1 + Math.floor(next() * 13);
      const values = Array.from({ length: n }, () => 0.2 + 0.2 * next());
      // Some zero weights, like duplicate points.
      const weights = Array.from({ length: n }, () => (next() < 0.1 ? 0 : 1 + 20 * next()));
      const maxPieces = 1 + Math.floor(next() * n);
      const minW = next() < 0.4 ? 0 : 30 * next();
      const label = `seed ${seed} trial ${trial}: n ${n} K ${maxPieces} minW ${minW}`;
      const result = segmentLeastSquares(values, weights, { maxPieces, minPieceWeight: minW });
      checkValid(result, values, weights, minW, label);
      const scale = weights.reduce((s, w, i) => s + w * values[i]! ** 2, 0);
      expectMatches(
        result.map((r) => r.error),
        bruteForce(values, weights, maxPieces, minW),
        scale,
        label,
      );
    }
  });
});

describe("segmentLeastSquares vs the unpruned recurrence", () => {
  // Brute force stops at a dozen points; these check the envelope pruning where it does real work.
  const seed = 42;
  const next = mulberry32(seed);
  const n = 240;
  const walk: number[] = [];
  for (let i = 0, v = 0.25; i < n; i++, v += (next() - 0.5) * 0.01) walk.push(v);
  const inputs: Record<string, number[]> = {
    "random walk": walk,
    "steps with noise": Array.from({ length: n }, (_, i) => 0.25 + 0.02 * (Math.floor(i / 37) % 3) + 0.002 * next()),
    "smooth hills": Array.from({ length: n }, (_, i) => 0.25 + 0.01 * Math.sin(i / 9) + 0.004 * Math.sin(i / 2.3)),
    "one spike": Array.from({ length: n }, (_, i) => (i === 100 ? 0.5 : 0.25)),
  };
  it.each(Object.entries(inputs))("matches on %s", (name, values) => {
    const weights = values.map((_, i) => (i % 17 === 0 ? 0 : 5 + (i % 5)));
    for (const minW of [0, 60]) {
      const label = `${name}, seed ${seed}, minW ${minW}`;
      const result = segmentLeastSquares(values, weights, { maxPieces: 8, minPieceWeight: minW });
      checkValid(result, values, weights, minW, label);
      const scale = weights.reduce((s, w, i) => s + w * values[i]! ** 2, 0);
      expectMatches(
        result.map((r) => r.error),
        naiveDp(values, weights, 8, minW),
        scale,
        label,
      );
    }
  });
});

describe("segmentLeastSquares", () => {
  it("keeps constant values in one piece however many are allowed", () => {
    const result = segmentLeastSquares(new Array<number>(50).fill(0.3), new Array<number>(50).fill(10), {
      maxPieces: 6,
    });
    for (const r of result) {
      expect(r.bounds).toEqual([0, 50]);
      expect(r.values[0]).toBeCloseTo(0.3, 15);
      expect(r.error).toBe(0);
    }
  });

  it("finds the steps of a step function", () => {
    const values = [...new Array<number>(10).fill(1), ...new Array<number>(5).fill(2), ...new Array<number>(8).fill(0)];
    const result = segmentLeastSquares(values, new Array<number>(values.length).fill(1), { maxPieces: 4 });
    expect(result[2]!.bounds).toEqual([0, 10, 15, 23]);
    expect(result[2]!.values).toEqual([1, 2, 0]);
    expect(result[2]!.error).toBeCloseTo(0, 12);
    // A fourth piece cannot help.
    expect(result[3]!.bounds).toEqual([0, 10, 15, 23]);
  });

  it("weights by length: a heavy interval pulls its piece's mean", () => {
    const [r] = segmentLeastSquares([1, 2], [3, 1], { maxPieces: 1 });
    expect(r!.values[0]).toBeCloseTo(1.25, 12);
    expect(r!.error).toBeCloseTo(3 * 0.25 ** 2 + 0.75 ** 2, 12);
  });

  it("falls back to one piece when the minimum cannot be met", () => {
    const result = segmentLeastSquares([1, 5, 1, 5], [1, 1, 1, 1], { maxPieces: 3, minPieceWeight: 10 });
    for (const r of result) expect(r.bounds).toEqual([0, 4]);
  });

  it("respects the minimum weight even when a short piece would fit better", () => {
    const values = [0, 0, 0, 0, 9, 0, 0, 0, 0];
    const free = segmentLeastSquares(values, new Array<number>(9).fill(1), { maxPieces: 3 });
    expect(free[2]!.bounds).toEqual([0, 4, 5, 9]);
    const constrained = segmentLeastSquares(values, new Array<number>(9).fill(1), { maxPieces: 3, minPieceWeight: 3 });
    for (const w of pieceWeights(new Array<number>(9).fill(1), constrained[2]!.bounds))
      expect(w).toBeGreaterThanOrEqual(3);
  });

  it("handles all-zero weights", () => {
    const [r] = segmentLeastSquares([1, 2, 3], [0, 0, 0], { maxPieces: 1 });
    expect(r!.bounds).toEqual([0, 3]);
    expect(r!.values).toEqual([0]);
    expect(r!.error).toBe(0);
  });

  it.each([
    [[1], [1, 2], { maxPieces: 1 }, /1 values but 2 weights/],
    [[], [], { maxPieces: 1 }, /nothing to segment/],
    [[1], [1], { maxPieces: 0 }, /maxPieces/],
    [[1], [1], { maxPieces: 1.5 }, /maxPieces/],
    [[1], [1], { maxPieces: 1, minPieceWeight: -1 }, /minPieceWeight/],
    [[1], [1], { maxPieces: 1, minPieceWeight: NaN }, /minPieceWeight/],
    [[NaN], [1], { maxPieces: 1 }, /value 0/],
    [[1], [-1], { maxPieces: 1 }, /weight 0/],
    [[1], [Infinity], { maxPieces: 1 }, /weight 0/],
  ])("rejects invalid input %#", (values, weights, options, message) => {
    expect(() => segmentLeastSquares(values, weights, options)).toThrow(message);
  });
});

describe("segmentPartition", () => {
  const values = [1, 1, 5, 5, 5, 2];
  const weights = [1, 2, 1, 1, 2, 4];

  it("gives each piece its weighted mean and the error the DP would give that partition", () => {
    const fixed = segmentPartition(values, weights, [0, 2, 5, 6]);
    expect(fixed.values).toEqual([1, 5, 2]);
    expect(fixed.error).toBeCloseTo(0, 9);
    expect(fixed.maxPieces).toBe(3);
    const one = segmentPartition(values, weights, [0, 6]);
    const dp = segmentLeastSquares(values, weights, { maxPieces: 1 })[0]!;
    expect(one).toEqual(dp);
    const two = segmentPartition(values, weights, [0, 3, 6]);
    expect(two.values[0]).toBeCloseTo((1 + 2 + 5) / 4, 12);
    expect(two.values[1]).toBeCloseTo((5 + 10 + 8) / 7, 12);
    expect(two.error).toBeCloseTo(directError(values, weights, [0, 3, 6]), 9);
  });

  it("rejects bounds that do not cover the values in increasing order", () => {
    for (const bounds of [[0, 5], [1, 6], [0], [0, 3, 3, 6], [0, 2.5, 6]]) {
      expect(() => segmentPartition(values, weights, bounds), String(bounds)).toThrow(RangeError);
    }
  });
});
