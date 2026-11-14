/**
 * Douglas-Peucker line simplification for drawing long tracks cheaply (map polylines, thumbnails,
 * share URLs). It never changes the course used for pacing.
 */
import { EARTH_RADIUS_M, type LatLon } from "./geo.ts";

const RAD = Math.PI / 180;

/**
 * Squared distance in square meters from `p` to the segment `a..b`, in a local equirectangular
 * projection (x east, y north, meters), which is accurate for the short spans of a track.
 */
function segmentDistanceSq(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq : 0;
  t = Math.min(1, Math.max(0, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/** Project points to meters around the first one, unwrapping longitude across the antimeridian. */
function project(points: readonly LatLon[]): [number, number][] {
  const origin = points[0] as LatLon;
  let meanLat = 0;
  for (const p of points) meanLat += p.lat;
  const kx = Math.cos((meanLat / points.length) * RAD) * EARTH_RADIUS_M * RAD;
  const ky = EARTH_RADIUS_M * RAD;
  let lon = origin.lon;
  let prevLon = origin.lon;
  return points.map((p) => {
    let d = p.lon - prevLon;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    lon += d;
    prevLon = p.lon;
    return [(lon - origin.lon) * kx, (p.lat - origin.lat) * ky];
  });
}

/**
 * Simplify a polyline with the Douglas-Peucker algorithm: keep the fewest points such that no
 * dropped point is more than `toleranceM` meters from the simplified line. The first and last
 * points are always kept, and the result holds the input's own point objects in order (so extra
 * fields such as `ele` or `distM` survive). Runs iteratively, so long tracks cannot overflow the
 * stack. Throws a `RangeError` for a negative or non-finite tolerance.
 */
export function simplify<T extends LatLon>(points: readonly T[], toleranceM: number): T[] {
  if (!(Number.isFinite(toleranceM) && toleranceM >= 0)) {
    throw new RangeError(`simplify: tolerance must be a non-negative number of meters, got ${toleranceM}`);
  }
  if (points.length <= 2) return points.slice();
  const xy = project(points);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const toleranceSq = toleranceM * toleranceM;
  const stack: [number, number][] = [[0, points.length - 1]];
  for (let span = stack.pop(); span; span = stack.pop()) {
    const [first, last] = span;
    const a = xy[first] as [number, number];
    const b = xy[last] as [number, number];
    let worst = -1;
    let worstSq = toleranceSq;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(xy[i] as [number, number], a, b);
      if (d > worstSq) {
        worstSq = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([first, worst], [worst, last]);
  }
  return points.filter((_, i) => keep[i] === 1);
}
