import { describe, expect, it } from "vitest";
import {
  type Course,
  DEFAULT_RESAMPLE_SPACING_M,
  type TrackPoint,
  buildCourse,
  courseBearingsDeg,
  courseLengthM,
  initialBearingDeg,
  haversineM,
  pointAtDistance,
  resampleCourse,
} from "../src/index.ts";
import { randomTrack } from "./support/tracks.ts";

/** Geometric length of a course's polyline, recomputed from positions alone. */
function polylineM(course: Course): number {
  let total = 0;
  for (let i = 1; i < course.points.length; i++) {
    total += haversineM(course.points[i - 1] as TrackPoint, course.points[i] as TrackPoint);
  }
  return total;
}

// About 111.2 m per 0.001 degree of latitude.
const STRAIGHT: TrackPoint[] = [
  { lat: 0, lon: 0, ele: 10 },
  { lat: 0.001, lon: 0, ele: 20 },
  { lat: 0.002, lon: 0 },
  { lat: 0.003, lon: 0, ele: 40 },
];
const STEP = haversineM({ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 });

describe("buildCourse", () => {
  it("computes cumulative distance and keeps elevations", () => {
    const course = buildCourse(STRAIGHT);
    expect(course.points.map((p) => p.distM)).toEqual([
      0,
      STEP,
      expect.closeTo(2 * STEP, 9),
      expect.closeTo(3 * STEP, 9),
    ]);
    expect(course.points[0]).toEqual({ lat: 0, lon: 0, ele: 10, distM: 0 });
    expect(course.points[2]).not.toHaveProperty("ele");
    expect(courseLengthM(course)).toBeCloseTo(3 * STEP, 9);
  });

  it("copies rather than mutates its input", () => {
    const track = STRAIGHT.map((p) => ({ ...p }));
    const course = buildCourse(track);
    expect(track).toEqual(STRAIGHT);
    expect(course.points[0]).not.toBe(track[0]);
  });

  it("keeps duplicate consecutive points at zero distance", () => {
    const course = buildCourse([STRAIGHT[0], STRAIGHT[0], STRAIGHT[1]] as TrackPoint[]);
    expect(course.points.map((p) => p.distM)).toEqual([0, 0, STEP]);
  });

  it("handles empty and single-point tracks", () => {
    expect(buildCourse([])).toEqual({ points: [] });
    expect(courseLengthM(buildCourse([]))).toBe(0);
    expect(buildCourse([{ lat: 1, lon: 2 }])).toEqual({ points: [{ lat: 1, lon: 2, distM: 0 }] });
  });

  it.each([
    ["latitude", { lat: 90.1, lon: 0 }],
    ["latitude", { lat: Number.NaN, lon: 0 }],
    ["longitude", { lat: 0, lon: -180.1 }],
    ["longitude", { lat: 0, lon: Number.POSITIVE_INFINITY }],
    ["elevation", { lat: 0, lon: 0, ele: Number.NaN }],
  ])("rejects an invalid %s", (field, bad) => {
    expect(() => buildCourse([{ lat: 0, lon: 0 }, bad])).toThrow(new RegExp(`point 1 has invalid ${field}`));
  });
});

describe("pointAtDistance", () => {
  const course = buildCourse(STRAIGHT);

  it("interpolates position and elevation", () => {
    const p = pointAtDistance(course, 0.25 * STEP);
    expect(p.lat).toBeCloseTo(0.00025, 12);
    expect(p.lon).toBe(0);
    expect(p.ele).toBeCloseTo(12.5, 9);
    expect(p.distM).toBe(0.25 * STEP);
  });

  it("returns exact points at their own distances", () => {
    for (const q of course.points) expect(pointAtDistance(course, q.distM)).toEqual(q);
  });

  it("omits elevation when a neighbor has none", () => {
    expect(pointAtDistance(course, 1.5 * STEP)).not.toHaveProperty("ele");
  });

  it("clamps to the course", () => {
    expect(pointAtDistance(course, -5)).toEqual(course.points[0]);
    expect(pointAtDistance(course, 1e9)).toEqual(course.points.at(-1));
  });

  it("handles a single point and duplicate points", () => {
    expect(pointAtDistance(buildCourse([{ lat: 1, lon: 2 }]), 10)).toEqual({ lat: 1, lon: 2, distM: 0 });
    const dup = buildCourse([STRAIGHT[0], STRAIGHT[0]] as TrackPoint[]);
    expect(pointAtDistance(dup, 0)).toEqual(dup.points[0]);
  });

  it.each([
    ["an empty course", { points: [] }, 0],
    ["a non-finite distance", course, Number.NaN],
  ])("rejects %s", (_name, c, d) => {
    expect(() => pointAtDistance(c, d)).toThrow(RangeError);
  });
});

describe("resampleCourse", () => {
  it("samples at fixed spacing and ends on the exact end point", () => {
    const course = buildCourse(STRAIGHT);
    const out = resampleCourse(course, 100);
    const length = courseLengthM(course);
    expect(out.points.map((p) => p.distM)).toEqual([0, 100, 200, 300, length]);
    expect(out.points[0]).toEqual(course.points[0]);
    expect(out.points.at(-1)).toEqual(course.points.at(-1));
    expect(out.points[1]?.ele).toBeCloseTo(10 + (10 * 100) / STEP, 9);
    expect(out.points[2]).not.toHaveProperty("ele");
  });

  it("defaults to 10 m spacing", () => {
    expect(DEFAULT_RESAMPLE_SPACING_M).toBe(10);
  });

  it("adds no sliver interval when the length is a multiple of the spacing", () => {
    const course = buildCourse(STRAIGHT);
    const out = resampleCourse(course, courseLengthM(course) / 3);
    expect(out.points).toHaveLength(4);
  });

  it("keeps both ends of a course shorter than the spacing", () => {
    const course = buildCourse(STRAIGHT.slice(0, 2));
    expect(resampleCourse(course, 1000).points).toEqual(course.points);
  });

  it("handles empty and zero-length courses", () => {
    expect(resampleCourse({ points: [] }, 10)).toEqual({ points: [] });
    const still = buildCourse([STRAIGHT[0], STRAIGHT[0]] as TrackPoint[]);
    expect(resampleCourse(still, 10)).toEqual({ points: [still.points[0]] });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects spacing %s", (spacing) => {
    expect(() => resampleCourse(buildCourse(STRAIGHT), spacing)).toThrow(RangeError);
  });

  it("does not mutate the input course", () => {
    const course = buildCourse(STRAIGHT);
    const before = structuredClone(course);
    resampleCourse(course, 50);
    expect(course).toEqual(before);
  });

  describe("on seeded random tracks", () => {
    const seeds = [1, 2, 3, 42, 5999, 31337];
    const spacings = [5, DEFAULT_RESAMPLE_SPACING_M, 25];

    for (const seed of seeds) {
      for (const spacingM of spacings) {
        it(`preserves length and lies on the track (seed ${seed}, spacing ${spacingM} m)`, () => {
          const track = randomTrack(seed, {
            count: 800,
            minStepM: 2,
            maxStepM: 40,
            maxTurnDeg: 15,
            duplicateChance: 0.05,
            withEle: seed % 2 === 0,
          });
          const course = buildCourse(track);
          const length = courseLengthM(course);
          const out = resampleCourse(course, spacingM);
          const msg = `seed ${seed} spacing ${spacingM}`;

          // Length along the track is preserved exactly.
          expect(courseLengthM(out), msg).toBe(length);
          // The recomputed geometric length cuts corners, so it is shorter, but at the default
          // spacing or finer it stays within 0.1% even on these wiggly tracks.
          const shortfall = (length - polylineM(out)) / length;
          expect(shortfall, msg).toBeGreaterThan(-1e-9);
          if (spacingM <= DEFAULT_RESAMPLE_SPACING_M) expect(shortfall, msg).toBeLessThan(0.001);
          // Fixed spacing, with a final interval in (0, spacing].
          const d = out.points.map((p) => p.distM);
          expect(d.length, msg).toBe(Math.ceil(length / spacingM - 1e-6) + 1);
          for (let i = 1; i < d.length - 1; i++) expect(d[i], msg).toBeCloseTo(i * spacingM, 9);
          const tail = length - (d.at(-2) as number);
          expect(tail, msg).toBeGreaterThan(0);
          expect(tail, msg).toBeLessThanOrEqual(spacingM + 1e-9);
          // Each sample sits on the original track at its distance, and the ends are exact.
          for (const p of out.points) {
            const q = pointAtDistance(course, p.distM);
            expect(haversineM(p, q), msg).toBeLessThan(1e-6);
            expect(p.ele === undefined, msg).toBe(q.ele === undefined);
          }
          expect(out.points[0], msg).toEqual(course.points[0]);
          expect(out.points.at(-1), msg).toEqual(course.points.at(-1));
        });
      }
    }

    it("crosses the antimeridian without detours", () => {
      const course = buildCourse([
        { lat: 0, lon: 179.9995 },
        { lat: 0, lon: -179.9995 },
      ]);
      const out = resampleCourse(course, 10);
      expect(Math.abs(polylineM(out) - courseLengthM(course))).toBeLessThan(1e-6);
      for (const p of out.points) expect(Math.abs(p.lon)).toBeGreaterThan(179.999);
    });
  });
});

describe("courseBearingsDeg", () => {
  it("gives the direction of travel of every interval", () => {
    const course = buildCourse([
      { lat: 0, lon: 0 },
      { lat: 0.001, lon: 0 },
      { lat: 0.001, lon: 0.001 },
      { lat: 0, lon: 0.001 },
      { lat: 0, lon: 0 },
    ]);
    expect(Array.from(courseBearingsDeg(course), (d) => Math.round(d))).toEqual([0, 90, 180, 270]);
  });

  it("carries the previous bearing over duplicate points, and the first one back to the start", () => {
    const course = buildCourse([
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.001 },
      { lat: 0, lon: 0.001 },
      { lat: 0.001, lon: 0.001 },
    ]);
    expect(Array.from(courseBearingsDeg(course), (d) => Math.round(d))).toEqual([90, 90, 90, 0]);
  });

  it("is 0 for a course with no direction, and empty without an interval", () => {
    const still = buildCourse([
      { lat: 1, lon: 2 },
      { lat: 1, lon: 2 },
      { lat: 1, lon: 2 },
    ]);
    expect(Array.from(courseBearingsDeg(still))).toEqual([0, 0]);
    expect(courseBearingsDeg(buildCourse([{ lat: 1, lon: 2 }]))).toHaveLength(0);
    expect(courseBearingsDeg({ points: [] })).toHaveLength(0);
  });

  it("matches initialBearingDeg on random tracks with duplicates (seeded)", () => {
    const course = buildCourse(
      randomTrack(77, { count: 400, minStepM: 2, maxStepM: 20, maxTurnDeg: 40, duplicateChance: 0.1 }),
    );
    const bearings = courseBearingsDeg(course);
    expect(bearings).toHaveLength(course.points.length - 1);
    let last = Number.NaN;
    bearings.forEach((deg, i) => {
      const a = course.points[i]!;
      const b = course.points[i + 1]!;
      if (b.distM > a.distM) {
        last = initialBearingDeg(a, b);
        expect(deg, `seed 77 interval ${i}`).toBe(last);
      } else if (!Number.isNaN(last)) {
        expect(deg, `seed 77 interval ${i}`).toBe(last);
      }
      expect(deg).toBeGreaterThanOrEqual(0);
      expect(deg).toBeLessThan(360);
    });
  });
});
