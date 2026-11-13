function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Map over items with at most `limit` in flight. Results keep input order.
 * Rejects with the first error; once rejected or aborted, no new items start.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  opts?: { signal?: AbortSignal },
): Promise<R[]> {
  const signal = opts?.signal;
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed) {
      if (signal?.aborted) throw abortError();
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  if (signal?.aborted) throw abortError();
  return results;
}
