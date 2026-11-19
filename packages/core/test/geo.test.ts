import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_M, haversineM, initialBearingDeg, lerpLatLon } from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";

const QUARTER = (EARTH_RADIUS_M * Math.PI) / 2;

describe("haversineM", () => {
  it.each([
    ["the same point", { lat: 42.36, lon: -71.06 }, { lat: 42.36, lon: -71.06 }, 0],
    ["one degree of latitude", { lat: 0, lon: 0 }, { lat: 1, lon: 0 }, QUARTER / 90],
    ["a quarter of the equator", { lat: 0, lon: 0 }, { lat: 0, lon: 90 }, QUARTER],
    ["the equator to a pole", { lat: 0, lon: 37 }, { lat: 90, lon: 0 }, QUARTER],
    ["pole to pole", { lat: 90, lon: 0 }, { lat: -90, lon: 0 }, 2 * QUARTER],
    ["antipodes on the equator", { lat: 0, lon: 0 }, { lat: 0, lon: 180 }, 2 * QUARTER],
    ["across the antimeridian, the short way", { lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }, QUARTER / 90],
  ])("measures %s", (_name, a, b, expected) => {
    expect(haversineM(a, b)).toBeCloseTo(expected, 6);
  });

  it("puts the Boston Marathon start and finish about 39 km apart in a straight line", () => {
    // Hopkinton start and Copley Square finish.
    const d = haversineM({ lat: 42.2287, lon: -71.5226 }, { lat: 42.3499, lon: -71.0784 });
    expect(d).toBeGreaterThan(38_000);
    expect(d).toBeLessThan(39_200);
  });

  it("is symmetric, non-negative and obeys the triangle inequality (seeded)", () => {
    const seed = 2026;
    const next = mulberry32(seed);
    const point = () => ({ lat: -90 + 180 * next(), lon: -180 + 360 * next() });
    for (let i = 0; i < 500; i++) {
      const [a, b, c] = [point(), point(), point()];
      const ab = haversineM(a, b);
      const msg = `seed ${seed} iteration ${i}`;
      expect(ab, msg).toBeGreaterThanOrEqual(0);
      expect(ab, msg).toBeLessThanOrEqual(2 * QUARTER + 1e-6);
      expect(haversineM(b, a), msg).toBeCloseTo(ab, 6);
      expect(ab, msg).toBeLessThanOrEqual(haversineM(a, c) + haversineM(c, b) + 1e-6);
    }
  });
});

describe("lerpLatLon", () => {
  const a = { lat: 10, lon: 20 };
  const b = { lat: 12, lon: 26 };

  it.each([
    [0, a],
    [1, b],
    [0.5, { lat: 11, lon: 23 }],
  ])("at t = %s", (t, expected) => {
    expect(lerpLatLon(a, b, t)).toEqual(expected);
  });

  it.each([
    ["eastward", { lat: 0, lon: 179 }, { lat: 0, lon: -179 }, 0.25, 179.5],
    ["eastward past the line", { lat: 0, lon: 179 }, { lat: 0, lon: -179 }, 0.75, -179.5],
    ["westward", { lat: 0, lon: -179 }, { lat: 0, lon: 179 }, 0.25, -179.5],
    ["westward past the line", { lat: 0, lon: -179 }, { lat: 0, lon: 179 }, 0.75, 179.5],
  ])("takes the short way across the antimeridian %s", (_name, from, to, t, lon) => {
    expect(lerpLatLon(from, to, t).lon).toBeCloseTo(lon, 9);
  });
});

describe("initialBearingDeg", () => {
  it.each([
    ["north", { lat: 10, lon: 20 }, { lat: 10.01, lon: 20 }, 0],
    ["east", { lat: 0, lon: 20 }, { lat: 0, lon: 20.01 }, 90],
    ["south", { lat: 10, lon: 20 }, { lat: 9.99, lon: 20 }, 180],
    ["west", { lat: 0, lon: 20 }, { lat: 0, lon: 19.99 }, 270],
    ["northeast on the equator", { lat: 0, lon: 0 }, { lat: 0.001, lon: 0.001 }, 45],
    ["east across the antimeridian", { lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 }, 90],
    ["west across the antimeridian", { lat: 0, lon: -179.999 }, { lat: 0, lon: 179.999 }, 270],
    ["the same point", { lat: 42, lon: -71 }, { lat: 42, lon: -71 }, 0],
  ])("points %s", (_name, a, b, expected) => {
    expect(initialBearingDeg(a, b)).toBeCloseTo(expected, 3);
  });

  it("is always in [0, 360) and reverses by 180 over short hops (seeded)", () => {
    const next = mulberry32(4242);
    for (let k = 0; k < 500; k++) {
      const a = { lat: -60 + 120 * next(), lon: -180 + 360 * next() };
      const b = { lat: a.lat + (next() - 0.5) * 0.01, lon: a.lon + (next() - 0.5) * 0.01 };
      const there = initialBearingDeg(a, b);
      const back = initialBearingDeg(b, a);
      expect(there, `seed 4242 #${k}`).toBeGreaterThanOrEqual(0);
      expect(there, `seed 4242 #${k}`).toBeLessThan(360);
      const diff = (((back - there) % 360) + 360) % 360;
      expect(diff, `seed 4242 #${k}`).toBeCloseTo(180, 1);
    }
  });
});
