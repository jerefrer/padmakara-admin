/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * output order. Each worker claims the next index with `i = next++`; that read
 * cannot interleave with another worker's because it contains no await.
 *
 * Used to fan a batched list of Claude calls out concurrently while keeping the
 * total wall-clock inside the reverse-proxy read timeout.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      // Non-null: i is always a valid index of items here.
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
