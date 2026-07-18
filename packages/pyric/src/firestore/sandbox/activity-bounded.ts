/**
 * FIFO-evict the oldest entry once a bounded keyed store reaches capacity.
 * Insertion order doubles as age for both Map and Set stores; callers that
 * need recency semantics must re-insert touched keys themselves.
 */
export function evictOldest(store: {
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}): void {
  const oldest = store.keys().next().value as string | undefined;
  if (oldest !== undefined) store.delete(oldest);
}
