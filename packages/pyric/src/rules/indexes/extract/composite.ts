/**
 * Composite-index detection + QueryShape → IndexesConfigEntry mapping.
 *
 * Firestore's actual index-required rules are nuanced; this is a
 * conservative approximation that matches the cases the agent layer
 * needs to pre-seed:
 *
 *   - 0 filters and ≤ 1 orderBy → single-field, no composite needed.
 *   - 1 equality filter and 0 orderBy → single-field.
 *   - 1 equality filter + 1 orderBy on the same field → single-field.
 *   - 2+ equality filters → composite.
 *   - Equality filter + orderBy on a different field → composite.
 *   - Range/inequality filter + orderBy on a different field → composite.
 *   - array-contains is treated like equality for composite purposes.
 *
 * Vector indexes are not handled here — they have their own creation
 * surface that goes through the same deploy handler but with a
 * `vectorConfig` field on each indexed field.
 */
import type { Filter, QueryShape } from './types.js';
import type { IndexesConfigEntry, IndexFieldOrder } from '../types.js';

const EQ_LIKE = new Set(['==', 'in', 'array-contains', 'array-contains-any']);

function isEqualityLike(f: Filter): boolean {
  return EQ_LIKE.has(f.op);
}

export function needsCompositeIndex(s: QueryShape): boolean {
  const eq = s.filters.filter(isEqualityLike);
  const range = s.filters.filter(f => !isEqualityLike(f));

  // Trivially no composite — too few constraints.
  if (s.filters.length === 0 && s.orders.length <= 1) return false;
  if (s.filters.length === 1 && s.orders.length === 0) return false;

  // 2+ filters of any kind → composite.
  if (s.filters.length >= 2) return true;

  // Equality + orderBy: composite iff orderBy is on a different field.
  if (eq.length >= 1 && s.orders.length >= 1) {
    const orderField = s.orders[0].field;
    if (!eq.some(f => f.field === orderField)) return true;
  }

  // Range + orderBy on a different field → composite.
  if (range.length >= 1 && s.orders.length >= 1) {
    if (range[0].field !== s.orders[0].field) return true;
  }

  // 2+ orderBys → composite (Firestore needs an index for each ordering combo).
  if (s.orders.length >= 2) return true;

  return false;
}

/**
 * Map a QueryShape to a Firestore index-spec entry. The output drops
 * directly into `firestore.indexes.json`'s `indexes[]`.
 *
 * Field ordering rule: equality filters first (Firestore's docs put them
 * before range/orderBy), then range filters, then orderBy fields. Within
 * each group we preserve source order so the agent can correlate the
 * extracted index with the source query.
 */
export function shapeToIndexEntry(s: QueryShape): IndexesConfigEntry {
  const fields: { fieldPath: string; order: IndexFieldOrder }[] = [];

  // Equality filters → ASCENDING.
  for (const f of s.filters) {
    if (isEqualityLike(f)) {
      fields.push({ fieldPath: f.field, order: 'ASCENDING' });
    }
  }
  // Range filters → ASCENDING.
  for (const f of s.filters) {
    if (!isEqualityLike(f)) {
      fields.push({ fieldPath: f.field, order: 'ASCENDING' });
    }
  }
  // OrderBy fields — direction matters; only include fields not already in.
  for (const o of s.orders) {
    const existing = fields.findIndex(x => x.fieldPath === o.field);
    if (existing >= 0) {
      // The orderBy direction wins over a default-ascending entry from
      // the filter loop — Firestore's index requires the orderBy
      // direction to match.
      fields[existing] = { fieldPath: o.field, order: o.direction === 'desc' ? 'DESCENDING' : 'ASCENDING' };
    } else {
      fields.push({ fieldPath: o.field, order: o.direction === 'desc' ? 'DESCENDING' : 'ASCENDING' });
    }
  }

  // Last segment of the path is the collectionGroup (subcollection
  // queries pin the group to the leaf segment).
  const collectionGroup = s.collectionPath.split('/').pop() || s.collectionPath;

  return {
    collectionGroup,
    queryScope: s.isCollectionGroup ? 'COLLECTION_GROUP' : 'COLLECTION',
    fields,
  };
}

/**
 * Stable string key for an index entry — used by the orchestrator to
 * dedupe across multiple shapes that map to the same index.
 */
export function indexEntryKey(e: IndexesConfigEntry): string {
  const fields = e.fields.map(f => `${f.fieldPath}:${f.order ?? 'ASCENDING'}`).join(',');
  return `${e.queryScope}|${e.collectionGroup}|${fields}`;
}
