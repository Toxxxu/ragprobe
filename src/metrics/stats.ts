export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Percentile using linear interpolation between closest ranks. `p` is 0..100. */
export function percentile(values: readonly number[], p: number): number {
  if (p < 0 || p > 100) throw new RangeError(`percentile must be within 0..100, got ${p}`);
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loValue = sorted[lo] as number;
  const hiValue = sorted[hi] as number;
  return loValue + (hiValue - loValue) * (rank - lo);
}
