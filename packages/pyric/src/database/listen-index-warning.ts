import { isQuery } from './query-shape.js';
import { targetOf } from './routing.js';
import type { DatabaseReference, Query } from './types.js';

/**
 * The unspecified-index warning a listener on `target` logs, or `null` when
 * the target is a plain reference, reads the whole location, or is indexed.
 * A worker host that attaches listeners for a page reads this and hands the
 * warning to the page, where the SDK call was made.
 */
export function listenIndexWarning(target: DatabaseReference | Query): string | null {
  if (!isQuery(target)) return null;
  const resolved = targetOf(target.ref);
  if (resolved.admin === true) return null;
  return resolved.backend.unspecifiedIndexWarning(target.ref._path, target._spec);
}
