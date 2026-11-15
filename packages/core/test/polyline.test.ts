import { describe, expect, it } from "vitest";
import {
  type LatLon,
  PolylineError,
  decodePolyline,
  encodePolyline,
  fromUrlSafe,
  roundCoordinate,
  toUrlSafe,
} from "../src/index.ts";
import { mulberry32 } from "./support/rng.ts";
import { randomTrack } from "./support/tracks.ts";

const round = (p: LatLon, decimals: number): LatLon => {
  const scale = 10 ** decimals;
  return { lat: Math.round(p.lat * scale) / scale + 0, lon: Math.round(p.lon * scale) / scale + 0 };
};

describe("encoded polylines", () => {
  it("matches the published example of the format", () => {
    const points = [
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ];
    expect(encodePolyline(points)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual(points);
  });

  it("encodes nothing as nothing", () => {
    expect(encodePolyline([])).toBe("");
    expect(decodePolyline("")).toEqual([]);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`round-trips random tracks to the rounded positions (seed ${seed})`, () => {
      const track = randomTrack(seed, { count: 400, minStepM: 1, maxStepM: 400, maxTurnDeg: 60 });
      for (const decimals of [5, 6]) {
        const decoded = decodePolyline(encodePolyline(track, decimals), decimals);
        expect(decoded, `seed ${seed}, ${decimals} places`).toEqual(track.map((p) => round(p, decimals)));
      }
    });
  }

  it("brings positions rounded like waypoints back exactly", () => {
    const next = mulberry32(11);
    const points = Array.from({ length: 300 }, () => ({
      lat: roundCoordinate(-90 + 180 * next()),
      lon: roundCoordinate(-180 + 360 * next()),
    }));
    expect(decodePolyline(encodePolyline(points))).toEqual(points);
  });

  it("handles the corners of the globe and jumps across it", () => {
    const points = [
      { lat: 90, lon: 180 },
      { lat: -90, lon: -180 },
      { lat: 0, lon: 179.99999 },
      { lat: -0.00001, lon: -179.99999 },
      { lat: 0, lon: 0 },
    ];
    expect(decodePolyline(encodePolyline(points))).toEqual(points);
    expect(decodePolyline(encodePolyline(points, 7), 7)).toEqual(points);
  });

  it("never returns -0", () => {
    const [p] = decodePolyline(encodePolyline([{ lat: -0.000001, lon: -0.000001 }]));
    expect(Object.is(p!.lat, 0) && Object.is(p!.lon, 0)).toBe(true);
  });

  it("rejects text that is not a polyline", () => {
    expect(() => decodePolyline("_p~iF~ps|U ")).toThrow(PolylineError);
    expect(() => decodePolyline("_p~iF~ps|")).toThrow(/cut off/);
    expect(() => decodePolyline("_p~iF")).toThrow(/no longitude/);
    expect(() => decodePolyline("~~~~~~~~~~~~")).toThrow(/too long/);
  });

  it("rejects a bad precision or position", () => {
    expect(() => encodePolyline([], 8)).toThrow(RangeError);
    expect(() => decodePolyline("", 1.5)).toThrow(RangeError);
    expect(() => encodePolyline([{ lat: NaN, lon: 0 }])).toThrow(RangeError);
  });

  it("maps onto the URL-safe alphabet and back, one to one", () => {
    const all = Array.from({ length: 64 }, (_, i) => String.fromCharCode(63 + i)).join("");
    const safe = toUrlSafe(all);
    expect(safe).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");
    expect(fromUrlSafe(safe)).toBe(all);
    const track = randomTrack(9, { count: 200, minStepM: 1, maxStepM: 100, maxTurnDeg: 90 });
    const encoded = encodePolyline(track);
    expect(toUrlSafe(encoded)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(toUrlSafe(encoded))).toBe(toUrlSafe(encoded));
    expect(fromUrlSafe(toUrlSafe(encoded))).toBe(encoded);
  });

  it("rejects characters outside either alphabet", () => {
    expect(() => toUrlSafe("ab ")).toThrow(PolylineError);
    expect(() => fromUrlSafe("AB=")).toThrow(PolylineError);
  });
});
