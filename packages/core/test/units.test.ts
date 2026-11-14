import { describe, expect, it } from "vitest";
import {
  type DistanceUnit,
  formatDuration,
  formatPace,
  metersPerUnit,
  metersToUnit,
  paceFromUnit,
  paceToUnit,
  parseDuration,
  unitToMeters,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";

const UNITS: DistanceUnit[] = ["mi", "km"];

describe("distance conversions", () => {
  it("uses the exact international mile", () => {
    expect(metersPerUnit("mi")).toBe(1609.344);
    expect(metersPerUnit("km")).toBe(1000);
  });

  it("converts a marathon", () => {
    expect(metersToUnit(42_195, "mi")).toBeCloseTo(26.2188, 4);
    expect(metersToUnit(42_195, "km")).toBe(42.195);
    expect(unitToMeters(26.2, "mi")).toBeCloseTo(42_164.8128, 6);
  });

  it.each(UNITS)("round-trips distances and paces in %s (seeded)", (unit) => {
    const seed = 7;
    const next = mulberry32(seed);
    for (let i = 0; i < 1000; i++) {
      const meters = 1e6 * next();
      const pace = 2 * next();
      const msg = `seed ${seed} iteration ${i}`;
      expect(unitToMeters(metersToUnit(meters, unit), unit), msg).toBeCloseTo(meters, 6);
      expect(metersToUnit(unitToMeters(meters, unit), unit), msg).toBeCloseTo(meters, 6);
      expect(paceFromUnit(paceToUnit(pace, unit), unit), msg).toBeCloseTo(pace, 12);
      expect(paceToUnit(paceFromUnit(pace, unit), unit), msg).toBeCloseTo(pace, 12);
    }
  });

  it("converts a pace between units", () => {
    const perMeter = paceFromUnit(450, "mi"); // 7:30 per mile
    expect(paceToUnit(perMeter, "km")).toBeCloseTo(279.617, 3);
    expect(formatPace(perMeter, "mi")).toBe("7:30");
    expect(formatPace(perMeter, "km")).toBe("4:40");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [59.4, "0:59"],
    [59.6, "1:00"],
    [425, "7:05"],
    [3599, "59:59"],
    [3599.5, "1:00:00"],
    [3600, "1:00:00"],
    [3 * 3600 + 7, "3:00:07"],
    [26 * 3600 + 3 * 60 + 7, "26:03:07"],
  ])("formats %s s as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (seconds) => {
    expect(() => formatDuration(seconds)).toThrow(RangeError);
    expect(() => formatPace(seconds, "mi")).toThrow(RangeError);
  });
});

describe("parseDuration", () => {
  it.each([
    ["7:05", 425],
    ["0:00", 0],
    ["75:00", 4500],
    ["3:00:07", 10_807],
    [" 1:02:03 ", 3723],
  ])("parses %s as %s s", (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it.each(["", "7", "7:5", "7:60", "1:60:00", "1:00:60", "-1:00", "1:2:03", "a:bc", "1:00:00:00", "7.5:00"])(
    "rejects %j",
    (text) => {
      expect(parseDuration(text)).toBeUndefined();
    },
  );

  it("round-trips with formatDuration (seeded)", () => {
    const seed = 99;
    const next = mulberry32(seed);
    for (let i = 0; i < 1000; i++) {
      const seconds = Math.floor(200_000 * next());
      expect(parseDuration(formatDuration(seconds)), `seed ${seed} seconds ${seconds}`).toBe(seconds);
    }
  });
});
