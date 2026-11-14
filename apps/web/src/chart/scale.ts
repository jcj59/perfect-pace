/**
 * The math behind the elevation chart: linear scales, "nice" tick values, the course point
 * nearest a map position, and thinning a profile to what the chart can show.
 * Pure functions, so they are unit tested apart from the DOM.
 */

/** A linear map from a domain interval to a range interval, with its inverse. */
export interface LinearScale {
  (value: number): number;
  invert: (position: number) => number;
}

/** Maps `[d0, d1]` onto `[r0, r1]`. A zero-width domain maps everything to `r0`. */
export function linearScale([d0, d1]: readonly [number, number], [r0, r1]: readonly [number, number]): LinearScale {
  const span = d1 - d0;
  const k = span === 0 ? 0 : (r1 - r0) / span;
  const scale = ((value: number) => r0 + (value - d0) * k) as LinearScale;
  scale.invert = (position: number) => (k === 0 ? d0 : d0 + (position - r0) / k);
  return scale;
}

/**
 * The tick spacing for `span` split into about `count` intervals: 1, 2 or 5 times a power of 10,
 * whichever lands closest to the rough spacing (on a log scale). A non-positive span gets 1.
 */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0) || !Number.isFinite(span)) return 1;
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  let best = power;
  for (const m of [1, 2, 5, 10]) {
    if (Math.abs(Math.log(m * power) - Math.log(rough)) < Math.abs(Math.log(best) - Math.log(rough))) {
      best = m * power;
    }
  }
  return best;
}

/** Multiples of `step` from `from` to `to` inclusive, without floating-point drift (0.30000000000000004). */
export function ticksBetween(from: number, to: number, step: number): number[] {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const values: number[] = [];
  const first = Math.ceil(from / step - 1e-9);
  const last = Math.floor(to / step + 1e-9);
  for (let i = first; i <= last; i++) values.push(Number((i * step).toFixed(decimals)));
  return values;
}

export interface NiceAxis {
  /** The domain, widened outward to whole steps. */
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * An axis over `[min, max]` with about `count` intervals, its ends rounded outward to whole steps
 * so the first and last ticks sit on the edges. A span below `minSpan` is widened around its
 * middle first, so a flat course does not blow its last meter of noise up into hills.
 */
export function niceAxis(min: number, max: number, count: number, minSpan = 0): NiceAxis {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo, count);
  const niceMin = Math.floor(lo / step + 1e-9) * step;
  const niceMax = Math.ceil(hi / step - 1e-9) * step;
  return { min: niceMin, max: niceMax, step, ticks: ticksBetween(niceMin, niceMax, step) };
}

/** Ticks for a distance axis that starts at 0 and ends exactly at `length` (not rounded out). */
export function distanceTicks(length: number, count: number): { step: number; ticks: number[] } {
  const step = niceStep(length, count);
  return { step, ticks: ticksBetween(0, length, step) };
}

interface HasPosition {
  lat: number;
  lon: number;
}

/**
 * Index of the point nearest `(lat, lon)`, measured on a local flat projection (longitude scaled
 * by the cosine of the latitude), which is exact enough over the span of a course. On a course
 * that passes the same spot twice, the earlier pass wins a tie. -1 for no points.
 */
export function nearestIndex(points: readonly HasPosition[], lat: number, lon: number): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as HasPosition;
    let dLon = p.lon - lon;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    const dx = dLon * kx;
    const dy = p.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Thin `(x, y)` samples (x non-decreasing) to at most about four per column when `x` is cut into
 * `columns` equal columns: each column keeps its first, lowest, highest and last sample, in order.
 * The drawn line then looks the same as the full one, peaks and dips included, at a fraction of the
 * points (a marathon at 10 m spacing is about 4,200 samples for a chart about 300 px wide).
 */
export function thinForColumns(xs: readonly number[], ys: readonly number[], columns: number): number[] {
  const n = Math.min(xs.length, ys.length);
  if (n <= columns * 4 || columns <= 0) return Array.from({ length: n }, (_, i) => i);
  const x0 = xs[0] as number;
  const span = (xs[n - 1] as number) - x0 || 1;
  const keep: number[] = [];
  let start = 0;
  while (start < n) {
    const column = Math.min(columns - 1, Math.floor((((xs[start] as number) - x0) / span) * columns));
    let end = start;
    let lo = start;
    let hi = start;
    while (
      end + 1 < n &&
      Math.min(columns - 1, Math.floor((((xs[end + 1] as number) - x0) / span) * columns)) === column
    ) {
      end++;
      if ((ys[end] as number) < (ys[lo] as number)) lo = end;
      if ((ys[end] as number) > (ys[hi] as number)) hi = end;
    }
    for (const i of [...new Set([start, lo, hi, end])].sort((a, b) => a - b)) keep.push(i);
    start = end + 1;
  }
  return keep;
}
