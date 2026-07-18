/**
 * topK: the k smallest items by `cmp`, in ascending order, WITHOUT sorting the
 * whole input. Equivalent to `[...items].sort(cmp).slice(0, k)` when `cmp` is a
 * total order (no ties), which the query engine guarantees since its
 * normalized orderBy ends with the unique `__name__` key. Used by `limit`
 * queries (no full sort) and, later, by `findNearest`'s vector top-k.
 *
 * Maintains a bounded ascending buffer of size <= k via binary insertion: O(n
 * log k) comparisons and O(k) extra space, vs the full sort's O(n log n) + O(n).
 */
export function topK<T>(items: Iterable<T>, k: number, cmp: (a: T, b: T) => number): T[] {
  if (k <= 0) return [];
  const top: T[] = [];
  for (const item of items) {
    if (top.length < k) {
      insertSorted(top, item, cmp);
    } else if (cmp(item, top[top.length - 1]!) < 0) {
      // `item` ranks ahead of the current k-th: evict the largest, insert this.
      top.pop();
      insertSorted(top, item, cmp);
    }
    // else: item is no smaller than the k-th best, so it cannot make the cut.
  }
  return top;
}

/** Insert `item` into the ascending array `arr` at its sorted position. Ties
 *  (cmp === 0) land AFTER equal elements, preserving input order among equals. */
function insertSorted<T>(arr: T[], item: T, cmp: (a: T, b: T) => number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(item, arr[mid]!) < 0) hi = mid;
    else lo = mid + 1;
  }
  arr.splice(lo, 0, item);
}
