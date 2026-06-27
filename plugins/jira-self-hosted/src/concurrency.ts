/**
 * Run `fn` over `items` with at most `limit` calls in flight at once,
 * preserving input order in the result. Jira REST has no batch primitive, so
 * resolving many boards (each one HTTP round-trip) would otherwise fan out an
 * unbounded burst of requests against the instance. Bounding the in-flight
 * count keeps a large board list from tripping Jira's per-user rate limits.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const ceiling = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: ceiling }, () => worker()));
  return results;
}
