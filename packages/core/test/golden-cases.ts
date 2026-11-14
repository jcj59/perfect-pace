import { prefixSums } from "../src/index.ts";
import { PRECISION, roundTo } from "./support/precision.ts";
import { randomValues } from "./support/rng.ts";

/**
 * One golden case: a frozen, JSON-serializable output plus a few headline numbers for
 * `golden-summary.md`. Later PRs add one case per fixture course (point count, distance,
 * gain/loss, grade profile and plans). Round every number with `roundTo` and `PRECISION`.
 */
export interface GoldenCase {
  /** File-safe name; the snapshot is `test/golden/<name>.json`. */
  name: string;
  description: string;
  compute: () => { output: unknown; summary: Record<string, string | number> };
}

export const goldenCases: GoldenCase[] = [
  {
    name: "harness-prefix-sums",
    description: "Harness check: prefix sums of 16 seeded values in [0, 100).",
    compute: () => {
      const prefix = Array.from(prefixSums(randomValues(6000, 16, 0, 100)), (v) => roundTo(v, PRECISION.ratio));
      return {
        output: { count: prefix.length - 1, prefix },
        summary: { count: prefix.length - 1, total: prefix.at(-1) ?? 0 },
      };
    },
  },
];
