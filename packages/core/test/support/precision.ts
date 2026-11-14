/**
 * Stated rounding precision for golden snapshots, so snapshots do not churn on
 * floating-point noise. Round every number that goes into a snapshot with one of these.
 */
export const PRECISION = {
  /** Distances: 1 m. */
  distanceM: 1,
  /** Elevations, gain and loss: 0.1 m. */
  elevationM: 0.1,
  /** Paces: 0.1 s per mile (or km). */
  paceS: 0.1,
  /** Dimensionless values such as grades and generic sums: 0.001. */
  ratio: 0.001,
} as const;

/** Round `value` to the nearest multiple of `step`, normalizing -0 to 0. */
export function roundTo(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const rounded = Number((Math.round(value / step) * step).toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
}
