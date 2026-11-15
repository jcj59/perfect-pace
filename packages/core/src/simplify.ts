/**
 * Douglas-Peucker line simplification for drawing long tracks cheaply (map polylines, thumbnails,
 * share URLs). It never changes the course used for pacing.
 */
import { EARTH_RADIUS_M, type LatLon } from "./geo.ts";

const RAD = Math.PI / 180;

/**
 * Points projected to meters around the first one (x east, y north) in a local equirectangular
 * projection, which is accurate for the short spans of a track, unwrapping longitude across the
 * antimeridian. Typed arrays, so a 50k-point track projects without 50k small allocations.
 */
function project(points: readonly LatLon[]): { xs: Float64Array; ys: Float64Array } {
  const origin = points[0] as LatLon;
  let meanLat = 0;
  for (const p of points) meanLat += p.lat;
  const kx = Math.cos((meanLat / points.length) * RAD) * EARTH_RADIUS_M * RAD;
  const ky = EARTH_RADIUS_M * RAD;
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  let lon = origin.lon;
  let prevLon = origin.lon;
  points.forEach((p, i) => {
    let d = p.lon - prevLon;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    lon += d;
    prevLon = p.lon;
    xs[i] = (lon - origin.lon) * kx;
    ys[i] = (p.lat - origin.lat) * ky;
  });
  return { xs, ys };
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
  const { xs, ys } = project(points);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const toleranceSq = toleranceM * toleranceM;
  // Spans still to check, as `first, last` pairs.
  const stack: number[] = [0, points.length - 1];
  while (stack.length > 0) {
    const last = stack.pop() as number;
    const first = stack.pop() as number;
    const ax = xs[first] as number;
    const ay = ys[first] as number;
    const dx = (xs[last] as number) - ax;
    const dy = (ys[last] as number) - ay;
    const lengthSq = dx * dx + dy * dy;
    let worst = -1;
    let worstSq = toleranceSq;
    for (let i = first + 1; i < last; i++) {
      // Squared distance from point i to the segment first..last.
      const px = xs[i] as number;
      const py = ys[i] as number;
      let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
      t = Math.min(1, Math.max(0, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > worstSq) {
        worstSq = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(first, worst, worst, last);
  }
  return points.filter((_, i) => keep[i] === 1);
}
