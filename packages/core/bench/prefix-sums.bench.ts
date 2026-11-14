import { bench, describe } from "vitest";
import { prefixSums } from "../src/index.ts";
import { randomValues } from "../test/support/rng.ts";

// Every bench name must have a budget in budgets.json; check-budgets.mjs enforces both ways.
const values = randomValues(1, 50_000);

describe("core", () => {
  bench("prefixSums over 50k values", () => {
    prefixSums(values);
  });
});
