import { describe, expect, it } from "vitest";
import {
  distanceTicks,
  linearScale,
  nearestIndex,
  niceAxis,
  niceStep,
  thinForColumns,
  ticksBetween,
} from "../src/chart/scale.ts";

describe("linearScale", () => {
  it("maps the domain onto the range and back", () => {
    const s = linearScale([0, 10], [100, 300]);
    expect(s(0)).toBe(100);
    expect(s(5)).toBe(200);
    expect(s(10)).toBe(300);
    expect(s.invert(250)).toBe(7.5);
  });

  it("handles an inverted range (SVG y grows downward)", () => {
    const s = linearScale([50, 150], [120, 20]);
    expect(s(50)).toBe(120);
    expect(s(150)).toBe(20);
    expect(s.invert(70)).toBe(100);
  });

  it("maps a zero-width domain to the start of the range", () => {
    const s = linearScale([3, 3], [0, 100]);
    expect(s(3)).toBe(0);
    expect(s(9)).toBe(0);
    expect(s.invert(42)).toBe(3);
  });
});

describe("niceStep", () => {
  it("picks 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(26.2, 4)).toBe(5);
    expect(niceStep(42.2, 4)).toBe(10);
    expect(niceStep(3.1, 4)).toBe(1);
    expect(niceStep(1.2, 4)).toBe(0.2);
    expect(niceStep(0.35, 4)).toBe(0.1);
    expect(niceStep(840, 3)).toBe(200);
    expect(niceStep(130, 3)).toBe(50);
  });

  it("returns 1 for an empty or invalid span", () => {
    expect(niceStep(0, 4)).toBe(1);
    expect(niceStep(-5, 4)).toBe(1);
    expect(niceStep(Number.NaN, 4)).toBe(1);
    expect(niceStep(10, 0)).toBe(1);
  });
});

describe("ticksBetween", () => {
  it("lists whole multiples without floating-point drift", () => {
    expect(ticksBetween(0, 1, 0.1)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(ticksBetween(0.05, 0.31, 0.1)).toEqual([0.1, 0.2, 0.3]);
    expect(ticksBetween(-40, 40, 20)).toEqual([-40, -20, 0, 20, 40]);
  });
});

describe("niceAxis", () => {
  it("rounds the ends outward to whole steps", () => {
    expect(niceAxis(12, 138, 3)).toEqual({ min: 0, max: 150, step: 50, ticks: [0, 50, 100, 150] });
    expect(niceAxis(-3, 37, 3)).toEqual({ min: -10, max: 40, step: 10, ticks: [-10, 0, 10, 20, 30, 40] });
  });

  it("keeps ends that already sit on a step", () => {
    expect(niceAxis(100, 200, 2)).toEqual({ min: 100, max: 200, step: 50, ticks: [100, 150, 200] });
  });

  it("widens a nearly flat span around its middle", () => {
    const axis = niceAxis(10, 11, 3, 30);
    expect(axis.max - axis.min).toBeGreaterThanOrEqual(30);
    expect(axis.min).toBeLessThanOrEqual(10);
    expect(axis.max).toBeGreaterThanOrEqual(11);
  });

  it("survives a perfectly flat course with no minimum span", () => {
    const axis = niceAxis(5, 5, 3);
    expect(axis.max).toBeGreaterThan(axis.min);
    expect(axis.ticks.length).toBeGreaterThan(1);
  });
});

describe("distanceTicks", () => {
  it("starts at zero and stops at or before the length", () => {
    expect(distanceTicks(26.22, 4)).toEqual({ step: 5, ticks: [0, 5, 10, 15, 20, 25] });
    expect(distanceTicks(42.2, 4)).toEqual({ step: 10, ticks: [0, 10, 20, 30, 40] });
    expect(distanceTicks(0.8, 4)).toEqual({ step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8] });
  });

  it("keeps labels readable at a phone width (about four intervals)", () => {
    for (const length of [0.5, 3.1, 6.2, 13.1, 26.2, 31.07, 50, 100]) {
      const { ticks } = distanceTicks(length, 4);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(8);
    }
  });
});

describe("nearestIndex", () => {
  it("finds the closest point by ground distance, not raw degrees", () => {
    // At 60 degrees north a degree of longitude is half a degree of latitude on the ground.
    const points = [
      { lat: 60, lon: 0.0018 }, // 100 m east
      { lat: 60.0012, lon: 0 }, // 133 m north
    ];
    expect(nearestIndex(points, 60, 0)).toBe(0);
  });

  it("prefers the earlier pass of an out-and-back on a tie", () => {
    const points = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 0, lon: 0 },
    ];
    expect(nearestIndex(points, 0, 0.1)).toBe(0);
  });

  it("wraps across the antimeridian", () => {
    const points = [
      { lat: 0, lon: 179.9 },
      { lat: 0, lon: 170 },
    ];
    expect(nearestIndex(points, 0, -179.95)).toBe(0);
  });

  it("returns -1 for no points", () => {
    expect(nearestIndex([], 0, 0)).toBe(-1);
  });
});

describe("thinForColumns", () => {
  it("keeps every sample when there are few", () => {
    expect(thinForColumns([0, 1, 2], [5, 6, 7], 100)).toEqual([0, 1, 2]);
  });

  it("keeps each column's first, last, lowest and highest sample in order", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const ys = xs.map((x) => (x === 437 ? 900 : x === 612 ? -900 : Math.sin(x / 30)));
    const keep = thinForColumns(xs, ys, 10);
    expect(keep.length).toBeLessThanOrEqual(40);
    expect(keep).toContain(0);
    expect(keep).toContain(999);
    expect(keep).toContain(437);
    expect(keep).toContain(612);
    expect([...keep].sort((a, b) => a - b)).toEqual(keep);
    expect(new Set(keep).size).toBe(keep.length);
  });
});
