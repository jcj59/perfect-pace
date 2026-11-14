import { describe, expect, it } from "vitest";
import { PRECISION, roundTo } from "./support/precision.ts";

describe("roundTo", () => {
  it.each([
    [1234.5678, PRECISION.distanceM, 1235],
    [12.349, PRECISION.elevationM, 12.3],
    [431.25, PRECISION.paceS, 431.3],
    [0.12345, PRECISION.ratio, 0.123],
    [-0.0001, PRECISION.ratio, 0],
  ])("rounds %s to step %s as %s", (value, step, expected) => {
    expect(roundTo(value, step)).toBe(expected);
    expect(Object.is(roundTo(value, step), -0)).toBe(false);
  });
});
