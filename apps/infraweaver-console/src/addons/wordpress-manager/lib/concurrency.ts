/**
 * Bounded-concurrency fan-out, shared by the fleet Connector-update sweep and the
 * per-site Manage panel capture. Both need to run many async jobs against pods/
 * ConfigMaps without firing them all at once — an unbounded burst either blows a
 * 409-retry budget (update sweep) or hammers one slow pod into returning empty
 * exec output (panel capture). Kept dependency-free so any layer can reuse it.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight at once, preserving
 * input order in the results. `worker` is expected never to reject (each caller
 * catches its own failure into a result object); a throw would still reject the
 * pool, which is acceptable since it can only mean a programmer error, not a job
 * failure.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, runner);
  await Promise.all(lanes);
  return results;
}
