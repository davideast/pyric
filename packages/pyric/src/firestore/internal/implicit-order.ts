/**
 * Firestore's normalized query order (`queryNormalizedOrderBy`), shared by the
 * in-page engine and the served client, which sends it to the host when a
 * query has a snapshot cursor. Keeping one copy keeps the planes in step
 * (#1364, FL-4).
 */
import { fieldPathKeySegments } from '../sandbox/update-fields.js';
import { compareUtf8Strings } from '../sandbox/utf8-order.js';

export interface ImplicitOrderClause {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

const KEY_FIELD = '__name__';

/** Field paths compare segment by segment (`FieldPath.comparator`). */
export function compareFieldPaths(a: string, b: string): number {
  const aSegments = fieldPathKeySegments(a);
  const bSegments = fieldPathKeySegments(b);
  const n = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < n; i++) {
    const left = aSegments[i];
    const right = bSegments[i];
    if (left === undefined || right === undefined) continue;
    const cmp = compareUtf8Strings(left, right);
    if (cmp !== 0) return cmp;
  }
  return aSegments.length - bSegments.length;
}

/**
 * The explicit orders, then each inequality field not already ordered, in
 * field-path order (the SDK keeps them in a sorted set), then the document
 * key. Implicit clauses take the last explicit direction, or `asc`.
 */
export function normalizeQueryOrders(
  explicitOrders: readonly ImplicitOrderClause[],
  inequalityFields: Iterable<string>,
): ImplicitOrderClause[] {
  const out: ImplicitOrderClause[] = [...explicitOrders];
  const seen = new Set(out.map((order) => order.field));
  let lastDirection: 'asc' | 'desc' = 'asc';
  const lastExplicit = explicitOrders[explicitOrders.length - 1];
  if (lastExplicit !== undefined) {
    lastDirection = lastExplicit.direction;
  }
  const unordered = [...new Set(inequalityFields)]
    .filter((field) => field !== KEY_FIELD && !seen.has(field));
  for (const field of unordered.sort(compareFieldPaths)) {
    seen.add(field);
    out.push({ field, direction: lastDirection });
  }
  if (!seen.has(KEY_FIELD)) out.push({ field: KEY_FIELD, direction: lastDirection });
  return out;
}
