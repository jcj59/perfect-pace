import { describe, expect, it } from "vitest";
import { type LatLon, type TrackPoint, buildCourse, haversineM, lerpLatLon, simplify } from "../src/index.ts";
import { randomTrack } from "./support/tracks.ts";

/** Distance in meters from `p` to the segment `a..b`, sampled finely along it. */
function distanceToSegment(p: LatLon, a: LatLon, b: LatLon): number {
  let best = Infinity;
  for (let k = 0; k <= 1000; k++) best = Math.min(best, haversineM(p, lerpLatLon(a, b, k / 1000)));
  return best;
}

describe("simplify", () => {
  it("drops collinear points and keeps the ends", () => {
    const line = [0, 1, 2, 3, 4].map((i) => ({ lat: 0, lon: i * 0.001 }));
    expect(simplify(line, 1)).toEqual([line[0], line[4]]);
  });

  it("keeps a corner larger than the tolerance and drops one smaller", () => {
    // About 11 m off the straight line from the first to the last point.
    const line = [
      { lat: 0, lon: 0 },
      { lat: 0.0001, lon: 0.001 },
      { lat: 0, lon: 0.002 },
    ];
    expect(simplify(line, 5)).toHaveLength(3);
    expect(simplify(line, 20)).toHaveLength(2);
  });

  it("returns the input's own objects, with their extra fields", () => {
    const course = buildCourse([
      { lat: 0, lon: 0, ele: 1 },
      { lat: 0.001, lon: 0.001, ele: 2 },
      { lat: 0, lon: 0.002, ele: 3 },
    ]);
    const out = simplify(course.points, 1);
    expect(out[1]).toBe(course.points[1]);
    expect(out[1]?.distM).toBeGreaterThan(0);
  });

  it("handles short inputs, a zero tolerance, closed loops and the antimeridian", () => {
    expect(simplify([], 1)).toEqual([]);
    const two = [
      { lat: 1, lon: 1 },
      { lat: 2, lon: 2 },
    ];
    expect(simplify(two, 1)).toEqual(two);
    expect(simplify(two, 1)).not.toBe(two);
    const loop = [
      { lat: 0, lon: 0 },
      { lat: 0.001, lon: 0 },
      { lat: 0.001, lon: 0.001 },
      { lat: 0, lon: 0 },
    ];
    expect(simplify(loop, 0)).toHaveLength(4);
    const across = [
      { lat: 0, lon: 179.999 },
      { lat: 0, lon: 180 },
      { lat: 0, lon: -179.999 },
    ];
    expect(simplify(across, 1)).toEqual([across[0], across[2]]);
  });

  it.each([-1, Number.NaN, Infinity])("rejects the tolerance %s", (tolerance) => {
    expect(() => simplify([{ lat: 0, lon: 0 }], tolerance)).toThrow(RangeError);
  });

  it.each([1, 2, 3, 4])("keeps every point within the tolerance on random track %i", (seed) => {
    const track: TrackPoint[] = randomTrack(seed, { count: 400, minStepM: 2, maxStepM: 20, maxTurnDeg: 30 });
    const toleranceM = 5;
    const out = simplify(track, toleranceM);
    expect(out.length, `seed ${seed}`).toBeLessThan(track.length / 2);
    expect(out[0]).toBe(track[0]);
    expect(out.at(-1)).toBe(track.at(-1));
    // Each dropped point is within the tolerance of the kept segment that replaced it.
    let k = 0;
    track.forEach((p, i) => {
      if (p === out[k + 1]) k++;
      else if (p !== out[k]) {
        const d = distanceToSegment(p, out[k]!, out[k + 1]!);
        expect(d, `seed ${seed}, point ${i}`).toBeLessThan(toleranceM * 1.01);
      }
    });
  });

  it("simplifies a 50k-point track without overflowing the stack", () => {
    const track = randomTrack(9, { count: 50_000, minStepM: 1, maxStepM: 5, maxTurnDeg: 20 });
    expect(simplify(track, 2).length).toBeLessThan(track.length);
  });
});
