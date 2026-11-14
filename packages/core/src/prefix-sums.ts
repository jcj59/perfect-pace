/**
 * Prefix sums of `values`: `out[0] = 0` and `out[i + 1] = values[0] + ... + values[i]`.
 *
 * Cumulative distance along a course and the segmenter's O(1) piece costs are both
 * built on this, so it lives in core from the start.
 */
export function prefixSums(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length + 1);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i] as number;
    out[i + 1] = total;
  }
  return out;
}

/** Sum of the original `values[start..end)` in O(1), given `prefix = prefixSums(values)`. */
export function rangeSum(prefix: Float64Array, start: number, end: number): number {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= prefix.length) {
    throw new RangeError(`rangeSum: invalid range [${start}, ${end}) for ${prefix.length - 1} values`);
  }
  return (prefix[end] as number) - (prefix[start] as number);
}
