export type Summary = { n: number; median: number; p95: number; p99: number; max: number };

// Nearest-rank percentile: the value at rank ceil(p/100 * n) of the ascending
// sample, 1-based. ADR 0001 names this method; it never interpolates.
export function nearestRank(sorted: ArrayLike<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

// Summary of the first n samples of a buffer that was sized up front. Sorts a
// copy; empty input gives null, never 0.
export function summarize(samples: ArrayLike<number>, n = samples.length): Summary | null {
  const count = Math.min(n, samples.length);
  if (count <= 0) return null;
  const sorted = new Float64Array(count);
  for (let i = 0; i < count; i++) sorted[i] = samples[i];
  sorted.sort();
  return {
    n: count,
    median: nearestRank(sorted, 50)!,
    p95: nearestRank(sorted, 95)!,
    p99: nearestRank(sorted, 99)!,
    max: sorted[count - 1],
  };
}
