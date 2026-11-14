/**
 * The course model: an ordered track of points, each carrying its cumulative distance along the
 * track. Every later stage (elevation, grade, pace model, segmenter) works on a `Course`, usually
 * one resampled to a fixed spacing by `resampleCourse`.
 */
import { type LatLon, haversineM, lerpLatLon } from "./geo.ts";

/** A track position with optional elevation in meters. */
export interface TrackPoint extends LatLon {
  ele?: number;
}

/** A course point: a track position plus its cumulative distance in meters from the start. */
export interface CoursePoint extends TrackPoint {
  distM: number;
}

/**
 * An ordered course. `points[0].distM` is 0 and `distM` never decreases, so the last point's
 * `distM` is the course length. Build one with `buildCourse`.
 */
export interface Course {
  points: CoursePoint[];
}

function assertTrackPoint(p: TrackPoint, index: number): void {
  if (!(Number.isFinite(p.lat) && p.lat >= -90 && p.lat <= 90)) {
    throw new RangeError(`buildCourse: point ${index} has invalid latitude ${p.lat}`);
  }
  if (!(Number.isFinite(p.lon) && p.lon >= -180 && p.lon <= 180)) {
    throw new RangeError(`buildCourse: point ${index} has invalid longitude ${p.lon}`);
  }
  if (p.ele !== undefined && !Number.isFinite(p.ele)) {
    throw new RangeError(`buildCourse: point ${index} has invalid elevation ${p.ele}`);
  }
}

function coursePoint(p: TrackPoint, distM: number): CoursePoint {
  return p.ele === undefined ? { lat: p.lat, lon: p.lon, distM } : { lat: p.lat, lon: p.lon, ele: p.ele, distM };
}

/**
 * Build a course from track points, computing cumulative haversine distance. The input is copied,
 * not mutated, and validated (finite latitude in [-90, 90], longitude in [-180, 180], finite
 * elevation when present); an invalid point throws a `RangeError`. Duplicate consecutive points
 * are kept, with zero distance between them.
 */
export function buildCourse(track: readonly TrackPoint[]): Course {
  const points: CoursePoint[] = [];
  let distM = 0;
  track.forEach((p, i) => {
    assertTrackPoint(p, i);
    const prev = points[i - 1];
    if (prev) distM += haversineM(prev, p);
    points.push(coursePoint(p, distM));
  });
  return { points };
}

/** The course length in meters (0 for an empty or single-point course). */
export function courseLengthM(course: Course): number {
  return course.points.at(-1)?.distM ?? 0;
}

/**
 * Index `i` of the segment `points[i]..points[i + 1]` that contains `distM`, by binary search,
 * for a course of at least two points. `distM` is clamped to the course.
 */
function segmentIndex(points: readonly CoursePoint[], distM: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if ((points[mid] as CoursePoint).distM <= distM) lo = mid;
    else hi = mid;
  }
  return lo;
}

function interpolate(a: CoursePoint, b: CoursePoint, distM: number): CoursePoint {
  const span = b.distM - a.distM;
  const t = span > 0 ? Math.min(1, Math.max(0, (distM - a.distM) / span)) : 0;
  // On a vertex, return it as is, so its elevation survives a neighbor without one.
  if (t === 0) return { ...a, distM };
  if (t === 1) return { ...b, distM };
  const { lat, lon } = lerpLatLon(a, b, t);
  if (a.ele === undefined || b.ele === undefined) return { lat, lon, distM };
  return { lat, lon, ele: a.ele + (b.ele - a.ele) * t, distM };
}

/**
 * The point `distM` meters along the course, interpolated linearly between the two neighboring
 * points (elevation too, when both have one). `distM` is clamped to `[0, length]`. Throws a
 * `RangeError` for an empty course or a non-finite distance.
 */
export function pointAtDistance(course: Course, distM: number): CoursePoint {
  const { points } = course;
  const first = points[0];
  if (!first) throw new RangeError("pointAtDistance: the course has no points");
  if (!Number.isFinite(distM)) throw new RangeError(`pointAtDistance: invalid distance ${distM}`);
  if (points.length === 1) return { ...first, distM: 0 };
  const d = Math.min(Math.max(distM, 0), courseLengthM(course));
  const i = segmentIndex(points, d);
  return interpolate(points[i] as CoursePoint, points[i + 1] as CoursePoint, d);
}

/** The resampling spacing the app uses unless told otherwise: 10 m. */
export const DEFAULT_RESAMPLE_SPACING_M = 10;

/**
 * Resample the course at a fixed `spacingM`: points at 0, spacing, 2 * spacing, and so on, plus
 * the exact end point, so the last interval may be shorter (it is never shorter than a millionth
 * of the spacing unless the whole course is). Positions and elevations are interpolated along the original track, and each
 * point's `distM` is its distance along the original track, so the length is preserved exactly.
 * A course shorter than one point, or of zero length, resamples to its first point alone.
 */
export function resampleCourse(course: Course, spacingM: number): Course {
  if (!(Number.isFinite(spacingM) && spacingM > 0)) {
    throw new RangeError(`resampleCourse: spacing must be a positive number of meters, got ${spacingM}`);
  }
  const { points } = course;
  const first = points[0];
  if (!first) return { points: [] };
  const lengthM = courseLengthM(course);
  if (lengthM === 0) return { points: [{ ...first, distM: 0 }] };

  const out: CoursePoint[] = [];
  const intervals = Math.max(1, Math.ceil(lengthM / spacingM - 1e-6));
  let seg = 0;
  for (let k = 0; k < intervals; k++) {
    const d = k * spacingM;
    while ((points[seg + 1] as CoursePoint).distM < d) seg++;
    out.push(interpolate(points[seg] as CoursePoint, points[seg + 1] as CoursePoint, d));
  }
  out.push({ ...(points.at(-1) as CoursePoint) });
  return { points: out };
}
