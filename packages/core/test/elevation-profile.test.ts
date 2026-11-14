import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Course,
  type CoursePoint,
  EARTH_RADIUS_M,
  DEFAULT_RESAMPLE_SPACING_M,
  MAX_ABS_GRADE,
  assessGpsElevation,
  buildCourse,
  buildElevationProfile,
  courseLengthM,
  parseGpx,
} from "../src/index.ts";
import { fixtureDemProvider, functionProvider, noDemProvider } from "./support/dem.ts";

const GPX_DIR = join(import.meta.dirname, "fixtures", "gpx");
const course = (file: string) => {
  const gpx = parseGpx(readFileSync(join(GPX_DIR, file), "utf8"));
  return (gpx.tracks[gpx.defaultTrack] ?? gpx.tracks[0])!.course;
};

const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180;

/**
 * A straight course north from the equator, one point every `stepM` with `ele(i)` at point `i`.
 * Distances are set exactly (not measured), so resampling at `stepM` lands on the points.
 */
function straight(count: number, ele: (i: number) => number | undefined, stepM = 10): Course {
  return {
    points: Array.from({ length: count }, (_, i) => {
      const e = ele(i);
      const p: CoursePoint = { lat: (i * stepM) / M_PER_DEG, lon: 0, distM: i * stepM };
      if (e !== undefined) p.ele = e;
      return p;
    }),
  };
}

/** A DEM that rises 1 m per 100 m going north, from 50 m at the equator. */
const tiltedDem = () => functionProvider((p) => 50 + (p.lat * M_PER_DEG) / 100);

/** Resampled points at 10 m with the given elevations. */
const resampled = (eles: (number | undefined)[]): CoursePoint[] =>
  eles.map((ele, i) =>
    ele === undefined ? { lat: 0, lon: 0, distM: 10 * i } : { lat: 0, lon: 0, ele, distM: 10 * i },
  );

describe("assessGpsElevation", () => {
  it("accepts complete, varied elevation", () => {
    expect(assessGpsElevation(resampled([10, 11, 12, 11]))).toEqual({ usable: true, gaps: [] });
  });

  it("lists missing and implausible points as gaps", () => {
    expect(assessGpsElevation(resampled([10, undefined, 9999, 12, -600, 11]))).toEqual({
      usable: true,
      gaps: [1, 2, 4],
    });
  });

  it("rejects missing, sparse, flat placeholder and spiky elevation", () => {
    expect(assessGpsElevation(resampled([undefined, undefined]))).toMatchObject({ usable: false, issue: "missing" });
    expect(assessGpsElevation(resampled([10, undefined, undefined, 9999]))).toMatchObject({
      usable: false,
      issue: "sparse",
    });
    expect(assessGpsElevation(resampled(Array<number>(101).fill(250)))).toMatchObject({ usable: false, issue: "flat" });
    // A short flat course is plausible as is.
    expect(assessGpsElevation(resampled(Array<number>(20).fill(250)))).toMatchObject({ usable: true });
    // 3 spikes in 100 points is over the 2% limit; 2 is not.
    const spiky = (n: number) =>
      resampled(Array.from({ length: 100 }, (_, i) => (i % 30 === 15 && i / 30 < n ? 300 : 100)));
    expect(assessGpsElevation(spiky(3))).toMatchObject({ usable: false, issue: "spiky" });
    expect(assessGpsElevation(spiky(2))).toMatchObject({ usable: true });
  });
});

describe("buildElevationProfile source policy (B3)", () => {
  it("fills a GPX without elevation from the fixture DEM", async () => {
    const log: string[] = [];
    const input = course("no-elevation.gpx");
    expect(input.points.every((p) => p.ele === undefined)).toBe(true);
    const profile = await buildElevationProfile(input, { provider: fixtureDemProvider({ log }) });
    expect(profile).toMatchObject({ source: "dem", gpsIssue: "missing", spacingM: DEFAULT_RESAMPLE_SPACING_M });
    expect(profile.demPoints).toBe(profile.course.points.length);
    // Downtown Ithaca, by Six Mile Creek: about 123 m.
    for (const p of profile.course.points) {
      expect(p.ele).toBeGreaterThan(115);
      expect(p.ele).toBeLessThan(130);
    }
    expect(profile.stats.minM).toBeGreaterThan(115);
    expect(new Set(log)).toEqual(new Set(["12/1177/1513"]));
  });

  it("replaces placeholder zeros the same way", async () => {
    const a = await buildElevationProfile(course("no-elevation.gpx"), { provider: fixtureDemProvider() });
    const b = await buildElevationProfile(course("zero-elevation.gpx"), { provider: fixtureDemProvider() });
    expect(b.source).toBe("dem");
    expect(b.stats).toEqual(a.stats);
  });

  it("uses complete, sane GPS elevation without asking the DEM", async () => {
    for (const file of ["boston.gpx", "newyork.gpx", "wineglass.gpx", "scurve.gpx", "dodge.gpx"]) {
      const profile = await buildElevationProfile(course(file), { provider: noDemProvider });
      expect(profile.source, file).toBe("gps");
      expect(profile.demPoints, file).toBe(0);
    }
  });

  it("always uses the DEM for a drawn route, even one carrying elevations", async () => {
    const dem = tiltedDem();
    const track = straight(31, () => 500);
    const profile = await buildElevationProfile(track, { provider: dem, origin: "drawn" });
    expect(profile.source).toBe("dem");
    expect(profile.gpsIssue).toBeUndefined();
    expect(dem.served).toBe(profile.course.points.length);
    expect(profile.rawEleM[0]).toBeCloseTo(50, 6);
    expect(profile.rawEleM.at(-1)).toBeCloseTo(53, 6);
  });

  it("fills gaps from the DEM, shifted to meet the GPS on both sides", async () => {
    // GPS reads 20 m above this DEM at the start and 30 m above at the end of a gap, so the fill
    // must ramp its offset from 20 to 30 instead of dropping to the DEM and jumping back.
    const track = straight(41, (i) => (i >= 10 && i <= 20 ? undefined : 70 + i / 10 + (i > 20 ? 10 : 0)));
    const dem = tiltedDem();
    const profile = await buildElevationProfile(track, { provider: dem, smoothing: { medianWindowM: 0, sigmaM: 0 } });
    expect(profile.source).toBe("gps+dem");
    expect(profile.demPoints).toBe(11);
    expect(dem.served).toBe(13); // the gap plus one neighbor on each side
    const raw = profile.rawEleM;
    expect(raw[9]).toBeCloseTo(70.9, 9);
    expect(raw[21]).toBeCloseTo(82.1, 9);
    for (let i = 10; i <= 20; i++) {
      const offset = 20 + ((i - 9) / 12) * 10;
      expect(raw[i], `point ${i}`).toBeCloseTo(50 + i / 10 + offset, 6);
    }
    // No step at either seam: the largest change between neighbors is the GPS's own 10 m jump spread over the gap.
    const steps = raw.slice(1).map((e, i) => Math.abs(e - (raw[i] as number)));
    expect(Math.max(...steps)).toBeLessThan(1);
  });

  it("fills gaps at the start and end from the one side they have", async () => {
    const track = straight(30, (i) => (i < 5 || i >= 25 ? undefined : 100));
    const profile = await buildElevationProfile(track, {
      provider: tiltedDem(),
      smoothing: { medianWindowM: 0, sigmaM: 0 },
    });
    const dem = (i: number) => 50 + i / 10;
    expect(profile.source).toBe("gps+dem");
    expect(profile.rawEleM[0]).toBeCloseTo(dem(0) + (100 - dem(5)), 6);
    expect(profile.rawEleM[29]).toBeCloseTo(dem(29) + (100 - dem(24)), 6);
  });

  it("fills the partial-elevation fixture from the fixture DEM", async () => {
    const profile = await buildElevationProfile(course("partial-elevation.gpx"), { provider: fixtureDemProvider() });
    expect(profile.source).toBe("dem");
    expect(profile.gpsIssue).toBe("sparse");
  });

  it("replaces spiky GPS elevation from the DEM", async () => {
    const track = straight(200, (i) => (i % 20 === 7 ? 400 : 100 + i / 10));
    const profile = await buildElevationProfile(track, { provider: tiltedDem() });
    expect(profile).toMatchObject({ source: "dem", gpsIssue: "spiky" });
    expect(profile.stats.maxM).toBeLessThan(80);
  });

  it("resamples at the requested spacing and keeps the length", async () => {
    const input = course("dodge.gpx");
    const profile = await buildElevationProfile(input, { provider: noDemProvider, spacingM: 25 });
    const pts = profile.course.points;
    expect(profile.spacingM).toBe(25);
    expect((pts[1] as CoursePoint).distM).toBe(25);
    expect(courseLengthM(profile.course)).toBe(courseLengthM(input));
    expect(profile.grades).toHaveLength(pts.length - 1);
    expect(profile.rawEleM).toHaveLength(pts.length);
    expect(profile.grades.every((g) => Math.abs(g) <= MAX_ABS_GRADE)).toBe(true);
    expect(pts.every((p) => p.ele !== undefined)).toBe(true);
  });

  it("honors the gain threshold option", async () => {
    const input = course("dodge.gpx");
    const loose = await buildElevationProfile(input, { provider: noDemProvider, gainThresholdM: 0 });
    const strict = await buildElevationProfile(input, { provider: noDemProvider, gainThresholdM: 20 });
    expect(loose.stats.gainM).toBeGreaterThan(strict.stats.gainM);
  });

  it("handles a one-point course and rejects an empty one", async () => {
    const one = await buildElevationProfile(buildCourse([{ lat: 1, lon: 1, ele: 5 }]), { provider: noDemProvider });
    expect(one).toMatchObject({ source: "gps", grades: [], stats: { gainM: 0, lossM: 0, minM: 5, maxM: 5 } });
    await expect(buildElevationProfile({ points: [] }, { provider: noDemProvider })).rejects.toThrow(RangeError);
  });

  it("passes provider failures through", async () => {
    await expect(buildElevationProfile(course("no-elevation.gpx"), { provider: noDemProvider })).rejects.toThrow(
      /should not/,
    );
  });
});

describe("GPS and DEM agree on authentic courses near Ithaca", () => {
  // The courses' own elevations against an independent measure, the fixture DEM. Gain is within
  // 10%: the two surfaces differ by under a meter on average, but where small rollers sit near the
  // hysteresis threshold, one counts them and the other does not. Run Go's Freeville track is
  // noisier, so it gets 25%.
  const cases: [file: string, gainTolerance: number][] = [
    ["dodge.gpx", 0.1],
    ["forest_home.gpx", 0.1],
    ["FH-Fox.gpx", 0.1],
    ["Freeville-Fly-In.gpx", 0.25],
  ];
  it.each(cases)("%s: gain within %d, profiles within a few meters", async (file, tolerance) => {
    const input = course(file);
    const gps = await buildElevationProfile(input, { provider: noDemProvider });
    const dem = await buildElevationProfile(input, { provider: fixtureDemProvider(), origin: "drawn" });
    expect(gps.source).toBe("gps");
    const relative = Math.abs(gps.stats.gainM - dem.stats.gainM) / dem.stats.gainM;
    expect(relative, `GPS ${gps.stats.gainM} m, DEM ${dem.stats.gainM} m`).toBeLessThan(tolerance);
    const diffs = gps.course.points.map((p, i) => Math.abs((p.ele as number) - (dem.course.points[i]?.ele as number)));
    expect(diffs.reduce((a, b) => a + b, 0) / diffs.length).toBeLessThan(5);
  });
});
