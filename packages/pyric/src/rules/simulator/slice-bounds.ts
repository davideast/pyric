/**
 * Range slice bounds for `value[start:end]` on a List or String, shared by
 * the Firestore simulator and the Storage evaluator.
 *
 * Production checks, in order, that `start` is an index, that `end - 1` is
 * an index, and that `start` does not exceed `end`; each failure is an
 * evaluation error. So `[0:0]`, `[n:n]` and any slice of an empty value are
 * errors, and `[i:i]` for 0 < i < n is empty. Firestore and Storage report the
 * same verdict and text for every shape (corpus scenarios
 * `range-slice-list-and-string` and `list-map-literals-and-slice`).
 */
import { indexOutOfBoundMessage } from './index-access.js';

/** Production's error text for a slice of a value of `size`, or null when the bounds are valid. */
export function sliceBoundsError(start: number, end: number, size: number): string | null {
  for (const index of [start, end - 1]) {
    if (index < 0 || index >= size) return indexOutOfBoundMessage(index, size);
  }
  if (start > end) return `Illegal range error. From index: [${start}] , To index: [${end}].`;
  return null;
}
