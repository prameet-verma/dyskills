function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Map over items with at most `limit` calls in flight (PRD §9.7 bounded parallelism).
 *
 * Results keep input order regardless of completion order. A limit below 1 is treated as 1.
 * Once any call rejects or the signal aborts, no further items are started; calls already in
 * flight are not cancelled.
 * @param items - Inputs to process.
 * @param limit - Maximum concurrent calls to `fn`.
 * @param fn - Async mapper receiving the item and its index.
 * @param opts - Optional `signal`; when aborted, the returned promise rejects.
 * @returns Mapped results in input order.
 * @throws The first error thrown by `fn`, or an `AbortError` if the signal aborted.
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

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  if (signal?.aborted) throw abortError();
  return results;
}
