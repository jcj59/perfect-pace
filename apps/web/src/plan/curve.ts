/**
 * The "error vs number of pace changes" curve beside the slider: where to draw each point, and
 * where the curve flattens out. Pure functions, unit tested apart from the DOM.
 */
import type { ErrorCurvePoint } from "@pp/core";

/**
 * The fewest pace changes that get `share` (default 90%) of all the improvement the curve offers,
 * from one steady pace (0 changes) to its last point. Past it, more changes barely help. 0 when
 * the curve is flat (a flat course gains nothing from changing pace).
 */
export function curveKnee(curve: readonly ErrorCurvePoint[], share = 0.9): number {
  const first = curve[0]?.rmsPaceGapSPerM ?? 0;
  const last = curve.at(-1)?.rmsPaceGapSPerM ?? 0;
  const gain = first - last;
  if (!(gain > 0)) return 0;
  const target = first - share * gain;
  const point = curve.find((p) => p.rmsPaceGapSPerM <= target + 1e-12);
  return point?.paceChanges ?? curve.at(-1)?.paceChanges ?? 0;
}

export interface CurvePoint {
  paceChanges: number;
  x: number;
  y: number;
}

/**
 * Screen positions for the curve in a `width` by `height` box. Point `k` sits at the slider
 * thumb's center for value `k`: the thumb travels between `inset` and `width - inset`. The y
 * axis runs from 0 (bottom, a perfect match) to the steady-pace gap (top, plus `top` px headroom).
 */
export function curvePoints(
  curve: readonly ErrorCurvePoint[],
  width: number,
  height: number,
  inset: number,
  top = 0,
): CurvePoint[] {
  const max = curve.at(-1)?.paceChanges ?? 0;
  const peak = Math.max(...curve.map((p) => p.rmsPaceGapSPerM), 0);
  const travel = Math.max(0, width - 2 * inset);
  const plot = Math.max(0, height - top);
  return curve.map((p) => ({
    paceChanges: p.paceChanges,
    x: inset + (max > 0 ? (travel * p.paceChanges) / max : 0),
    y: peak > 0 ? top + plot * (1 - p.rmsPaceGapSPerM / peak) : height,
  }));
}
