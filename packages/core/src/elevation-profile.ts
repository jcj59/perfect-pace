/**
 * The elevation profile of a course: resample to a fixed spacing, pick each point's elevation
 * source (the B3 policy below), smooth, and compute grades and headline stats.
 *
 * Source policy:
 *
 * - A **drawn** route has no elevation of its own, so it always uses the DEM.
 * - A **file** uses its GPS elevation when that is present and sane (see `assessGpsElevation`).
 *   Recorded altitude, often barometric, usually beats a DEM for the actual path run, which may
 *   cross bridges and underpasses that a DEM blurs.
 * - Sane GPS elevation with gaps (points without a value, or out of range) gets the gaps **filled**
 *   from the DEM. GPS and DEM disagree by a few meters on absolute height, so each filled run is
 *   shifted to meet the GPS values at both ends (the shift interpolated linearly along the gap).
 *   Pasting raw DEM values in would put a step at each end of the gap, which reads as fake climbing.
 * - Elevation that is missing or not sane is **replaced** from the DEM entirely.
 */
import {
  DEFAULT_GAIN_THRESHOLD_M,
  DEFAULT_MEDIAN_WINDOW_M,
  type ElevationStats,
  type SmoothingOptions,
  MAX_ABS_GRADE,
  computeGrades,
  elevationStats,
  medianFilter,
  smoothElevations,
} from "./elevation.ts";
import { type Course, type CoursePoint, DEFAULT_RESAMPLE_SPACING_M, resampleCourse } from "./course.ts";
import type { ElevationProvider } from "./terrarium.ts";

/** Where a course came from: an uploaded file, or drawn on the map (routed, no elevation). */
export type CourseOrigin = "file" | "drawn";

/** Where the profile's elevations came from. `gps+dem` is GPS with gaps filled from the DEM. */
export type ElevationSource = "gps" | "dem" | "gps+dem";

/** Why GPS elevation was not used as is. */
export type GpsElevationIssue = "missing" | "sparse" | "flat" | "spiky";

/** Lowest plausible elevation on land, meters: the Dead Sea shore is about -430 m. */
export const MIN_PLAUSIBLE_ELE_M = -500;
/** Highest plausible elevation, meters: Everest is 8849 m. */
export const MAX_PLAUSIBLE_ELE_M = 9000;
/** GPS elevation is used (with gaps filled) only when at least this share of points has it. */
export const MIN_GPS_COVERAGE = 0.5;
/** A point counts as a spike when it is this far from the median of its neighborhood. */
export const SPIKE_M = 20;
/**
 * GPS elevation with more than this share of spikes is replaced: a few spikes are a bad fix here
 * and there (smoothing removes them), but many mean the altitude is not usable.
 */
export const MAX_SPIKE_SHARE = 0.02;
/** A course this long with one constant elevation has a placeholder, not a measurement. */
export const FLAT_PLACEHOLDER_MIN_LENGTH_M = 1000;

/** The verdict on a course's GPS elevation, on its resampled points. */
export interface GpsElevationAssessment {
  /** Whether to use the GPS elevation (filling any gaps from the DEM). */
  usable: boolean;
  /** Why not, when `usable` is false. */
  issue?: GpsElevationIssue;
  /** The index of every point without a usable GPS elevation. */
  gaps: number[];
}

const plausible = (ele: number | undefined): ele is number =>
  ele !== undefined && ele >= MIN_PLAUSIBLE_ELE_M && ele <= MAX_PLAUSIBLE_ELE_M;

/**
 * Decide whether a course's GPS elevation is sane. It is not when no point has one (`missing`),
 * fewer than `MIN_GPS_COVERAGE` of points have a plausible one (`sparse`), a course of at least
 * `FLAT_PLACEHOLDER_MIN_LENGTH_M` has one constant value (`flat`), or more than `MAX_SPIKE_SHARE`
 * of points are spikes (`spiky`). Meant for evenly spaced points (see `resampleCourse`).
 */
export function assessGpsElevation(points: readonly CoursePoint[]): GpsElevationAssessment {
  const gaps: number[] = [];
  const distM: number[] = [];
  const eleM: number[] = [];
  points.forEach((p, i) => {
    if (plausible(p.ele)) {
      distM.push(p.distM);
      eleM.push(p.ele);
    } else gaps.push(i);
  });
  if (eleM.length === 0) return { usable: false, issue: "missing", gaps };
  if (eleM.length < MIN_GPS_COVERAGE * points.length) return { usable: false, issue: "sparse", gaps };
  const lengthM = (points.at(-1) as CoursePoint).distM - (points[0] as CoursePoint).distM;
  if (lengthM >= FLAT_PLACEHOLDER_MIN_LENGTH_M && eleM.every((e) => e === eleM[0])) {
    return { usable: false, issue: "flat", gaps };
  }
  const median = medianFilter(distM, eleM, DEFAULT_MEDIAN_WINDOW_M);
  const spikes = eleM.filter((e, i) => Math.abs(e - (median[i] as number)) > SPIKE_M).length;
  if (spikes > MAX_SPIKE_SHARE * eleM.length) return { usable: false, issue: "spiky", gaps };
  return { usable: true, gaps };
}

/**
 * Fill `ele[gap]` for each run of indexes in `gaps` from `dem`, shifted to meet the known values
 * on both sides of the run. A run at either end of the course uses the one side it has.
 */
function fillGaps(ele: number[], dem: number[], gaps: readonly number[]): void {
  let start = 0;
  while (start < gaps.length) {
    let end = start;
    while (end + 1 < gaps.length && (gaps[end + 1] as number) === (gaps[end] as number) + 1) end++;
    const first = gaps[start] as number;
    const last = gaps[end] as number;
    const before = first - 1;
    const after = last + 1;
    const offsetBefore = before >= 0 ? (ele[before] as number) - (dem[before] as number) : undefined;
    const offsetAfter = after < ele.length ? (ele[after] as number) - (dem[after] as number) : undefined;
    for (let i = first; i <= last; i++) {
      const t = (i - before) / (after - before);
      const offset =
        offsetBefore === undefined
          ? (offsetAfter as number)
          : offsetAfter === undefined
            ? offsetBefore
            : offsetBefore + (offsetAfter - offsetBefore) * t;
      ele[i] = (dem[i] as number) + offset;
    }
    start = end + 1;
  }
}

/** Options for `buildElevationProfile`. */
export interface ElevationProfileOptions {
  /** DEM elevations, used for drawn routes and for files without sane GPS elevation. */
  provider: ElevationProvider;
  /** Default `file`. */
  origin?: CourseOrigin;
  /** Resampling spacing in meters. Default `DEFAULT_RESAMPLE_SPACING_M` (10 m). */
  spacingM?: number;
  /** Smoothing windows. Defaults in `elevation.ts`. */
  smoothing?: SmoothingOptions;
  /** Gain/loss hysteresis threshold in meters. Default `DEFAULT_GAIN_THRESHOLD_M`. */
  gainThresholdM?: number;
}

/** A course's elevation profile, ready to show and to pace. */
export interface ElevationProfile {
  /**
   * The course resampled at `spacingM`, every point carrying its smoothed elevation. Distances are
   * along the original track, so the length is unchanged.
   */
  course: Course;
  spacingM: number;
  source: ElevationSource;
  /** Why the GPS elevation was replaced, when `source` is `dem` for a file. */
  gpsIssue?: GpsElevationIssue;
  /** How many points got their elevation from the DEM. */
  demPoints: number;
  /** Each point's elevation before smoothing (GPS, DEM or filled). */
  rawEleM: number[];
  /** Grade of each interval `i..i + 1` of `course`, clamped to `+/-MAX_ABS_GRADE`. */
  grades: number[];
  /** Gain, loss, minimum and maximum of the smoothed elevation. */
  stats: ElevationStats;
}

/**
 * Build the elevation profile of a course (at least one point) by the source policy in the module
 * doc. Asks `provider` only for the points that need DEM elevation (none for a file with complete,
 * sane GPS elevation) and rejects with its error if it fails.
 */
export async function buildElevationProfile(
  course: Course,
  options: ElevationProfileOptions,
): Promise<ElevationProfile> {
  const { provider, origin = "file", spacingM = DEFAULT_RESAMPLE_SPACING_M, smoothing } = options;
  const { gainThresholdM = DEFAULT_GAIN_THRESHOLD_M } = options;
  if (course.points.length === 0) throw new RangeError("buildElevationProfile: the course has no points");
  const points = resampleCourse(course, spacingM).points;
  const all = points.map((_, i) => i);

  let source: ElevationSource;
  let gpsIssue: GpsElevationIssue | undefined;
  let fromDem: number[];
  const rawEleM = points.map((p) => p.ele ?? 0);
  if (origin === "drawn") {
    source = "dem";
    fromDem = all;
  } else {
    const assessment = assessGpsElevation(points);
    if (assessment.usable) {
      fromDem = assessment.gaps;
      source = fromDem.length > 0 ? "gps+dem" : "gps";
    } else {
      source = "dem";
      gpsIssue = assessment.issue;
      fromDem = all;
    }
  }

  if (source === "dem") {
    const dem = await provider.elevations(points);
    dem.forEach((e, i) => (rawEleM[i] = e));
  } else if (source === "gps+dem") {
    // Ask for the gaps and their neighbors, which anchor the shift.
    const wanted = [...new Set(fromDem.flatMap((i) => [i - 1, i, i + 1]))].filter((i) => i >= 0 && i < points.length);
    const values = await provider.elevations(wanted.map((i) => points[i] as CoursePoint));
    const dem = new Array<number>(points.length).fill(0);
    wanted.forEach((i, k) => (dem[i] = values[k] as number));
    fillGaps(rawEleM, dem, fromDem);
  }

  const distM = points.map((p) => p.distM);
  const smoothed = smoothElevations(distM, rawEleM, smoothing);
  return {
    course: { points: points.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: smoothed[i] as number, distM: p.distM })) },
    spacingM,
    source,
    ...(gpsIssue === undefined ? {} : { gpsIssue }),
    demPoints: fromDem.length,
    rawEleM,
    grades: computeGrades(distM, smoothed, MAX_ABS_GRADE),
    stats: elevationStats(smoothed, gainThresholdM),
  };
}
