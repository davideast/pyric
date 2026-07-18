/**
 * Listener delivery / re-evaluation — change-suppression helpers for the
 * Firestore sandbox engine's snapshot notification path (ADR-0007
 * mechanical extraction from `local-environment.ts`).
 */
import type { DocumentData } from './local-state.js';

/**
 * Compare two doc payloads for snapshot-suppression purposes. `null`
 * means the doc is absent. Equality test uses `JSON.stringify` to
 * mirror `computeChanges` in `snapshot-listeners.ts` — keeps the two
 * change-detection paths consistent and good enough for sandbox data
 * (all `DocumentData` is JSON-serialisable post-sentinel-resolution).
 */
export function docDataEqual(a: DocumentData | null, b: DocumentData | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True if any path in `paths` is a direct child document of
 * `collection`. Used as a cheap pre-filter for query-listener
 * notifications: we only re-read the collection when something it
 * could plausibly contain was just touched. Slice 6 may revisit when
 * subcollection-aware queries land — current shape keeps the filter
 * conservative (no false negatives) at the cost of an occasional
 * false positive that the change-set diff then suppresses.
 */
export function anyPathInCollection(paths: ReadonlySet<string>, collection: string): boolean {
  const prefix = `${collection}/`;
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const remaining = p.slice(prefix.length);
    if (remaining.length > 0 && !remaining.includes('/')) return true;
  }
  return false;
}
