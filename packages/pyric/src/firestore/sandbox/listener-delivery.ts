/**
 * Listener delivery / re-evaluation — change-suppression helpers for the
 * Firestore sandbox engine's snapshot notification path (ADR-0007
 * mechanical extraction from `local-environment.ts`).
 */
import type { DocumentData } from './local-state.js';
import type { QueryScope } from './query-execution.js';

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
 * True if any path in `paths` is a document the query scope gathers: a
 * direct child document of the collection, or for a collection group, a
 * document in any collection with the group's id at any depth. Used as a
 * cheap pre-filter for query-listener notifications: the listener re-reads
 * only when something it could contain was just touched. The filter is
 * conservative (no false negatives); a false positive is suppressed by the
 * change-set diff.
 */
export function anyPathInQueryScope(paths: ReadonlySet<string>, scope: QueryScope): boolean {
  for (const p of paths) {
    if (scope.kind === 'collection-group') {
      const segments = p.split('/');
      if (segments.length % 2 === 0 && segments[segments.length - 2] === scope.collectionId) return true;
      continue;
    }
    const prefix = `${scope.path}/`;
    if (!p.startsWith(prefix)) continue;
    const remaining = p.slice(prefix.length);
    if (remaining.length > 0 && !remaining.includes('/')) return true;
  }
  return false;
}
