import { describe, expect, it } from "vitest";
import { prefixSums, rangeSum } from "../src/index.ts";
import { randomValues } from "./support/rng.ts";

describe("prefixSums", () => {
  it("starts at zero and accumulates", () => {
    expect(Array.from(prefixSums([1, 2, 3]))).toEqual([0, 1, 3, 7]);
  });

  it("handles an empty input", () => {
    expect(Array.from(prefixSums([]))).toEqual([0]);
  });
});

describe("rangeSum", () => {
  it("matches a direct sum on random ranges (seeded)", () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const values = randomValues(seed, 200, -50, 50);
      const prefix = prefixSums(values);
      const picks = randomValues(seed + 1, 50);
      for (let i = 0; i < picks.length; i += 2) {
        const a = Math.floor((picks[i] as number) * values.length);
        const b = Math.floor((picks[i + 1] as number) * values.length);
        const [start, end] = a <= b ? [a, b] : [b, a];
        const direct = values.slice(start, end).reduce((s, v) => s + v, 0);
        expect(rangeSum(prefix, start, end), `seed ${seed} [${start}, ${end})`).toBeCloseTo(direct, 9);
      }
    }
  });

  it.each([
    [-1, 2],
    [2, 1],
    [0, 4],
    [0.5, 2],
    [0, Number.NaN],
  ])("rejects the invalid range [%s, %s)", (start, end) => {
    expect(() => rangeSum(prefixSums([1, 2, 3]), start, end)).toThrow(RangeError);
  });
});

describe("package policy", () => {
  it("has no runtime dependencies", async () => {
    const { default: pkg } = (await import("../package.json", { with: { type: "json" } })) as {
      default: Record<string, unknown>;
    };
    expect(pkg["dependencies"]).toBeUndefined();
  });
});
