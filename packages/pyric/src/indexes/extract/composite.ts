/**
 * Composite-index detection + QueryShape -> IndexesConfigEntry mapping.
 *
 * Firestore automatically appends `__name__ ASCENDING` to every single-field
 * and composite index, so trailing `{ fieldPath: '__name__', order: 'ASCENDING' }`
 * is stripped as redundant while trailing `{ fieldPath: '__name__', order: 'DESCENDING' }`
 * and non-trailing `__name__` filter fields are preserved. Only index entries
 * with `fields.length >= 2` require a composite index.
 */
import type { Filter, QueryShape } from './types.js';
import type { IndexesConfigEntry, IndexField, IndexFieldOrder } from '../types.js';

const EQ_OPS = new Set(['==', 'in']);
const ARRAY_CONTAINS_OPS = new Set(['array-contains', 'array-contains-any']);
const EQ_LIKE = new Set(['==', 'in', 'array-contains', 'array-contains-any']);

function isEquality(f: Filter): boolean {
  return EQ_OPS.has(f.op);
}

function isArrayContains(f: Filter): boolean {
  return ARRAY_CONTAINS_OPS.has(f.op);
}

function isEqualityLike(f: Filter): boolean {
  return EQ_LIKE.has(f.op);
}

function stripRedundantTrailingNameAscending(fields: IndexField[]): void {
  while (fields.length > 0) {
    const last = fields[fields.length - 1]!;
    if (last.fieldPath === '__name__' && last.order === 'ASCENDING' && !last.arrayConfig) {
      fields.pop();
      continue;
    }
    break;
  }
}

function buildIndexFields(s: QueryShape): IndexField[] {
  const fields: IndexField[] = [];
  const seenOrder = new Set<string>();
  const seenContains = new Set<string>();

  for (const f of s.filters) {
    if (isEquality(f) && !seenOrder.has(f.field)) {
      seenOrder.add(f.field);
      fields.push({ fieldPath: f.field, order: 'ASCENDING' });
    }
  }
  for (const f of s.filters) {
    if (isArrayContains(f) && !seenContains.has(f.field)) {
      seenContains.add(f.field);
      fields.push({ fieldPath: f.field, arrayConfig: 'CONTAINS' });
    }
  }
  for (const f of s.filters) {
    if (!isEqualityLike(f) && !seenOrder.has(f.field)) {
      seenOrder.add(f.field);
      fields.push({ fieldPath: f.field, order: 'ASCENDING' });
    }
  }
  for (const o of s.orders) {
    let order: IndexFieldOrder = 'ASCENDING';
    if (o.direction === 'desc') {
      order = 'DESCENDING';
    }
    const existing = fields.findIndex((x) => x.fieldPath === o.field && !x.arrayConfig);
    if (existing >= 0) {
      fields[existing] = { fieldPath: o.field, order };
    } else {
      seenOrder.add(o.field);
      fields.push({ fieldPath: o.field, order });
    }
  }

  stripRedundantTrailingNameAscending(fields);
  return fields;
}

export function needsCompositeIndex(s: QueryShape): boolean {
  return buildIndexFields(s).length >= 2;
}

/**
 * Map a QueryShape to a Firestore index-spec entry. The output drops
 * directly into `firestore.indexes.json`'s `indexes[]`.
 *
 * Field ordering rule: equality filters first, then array-contains filters
 * (`arrayConfig: 'CONTAINS'`), then range filters, then orderBy fields, with
 * redundant trailing `__name__ ASCENDING` removed.
 */
export function shapeToIndexEntry(s: QueryShape): IndexesConfigEntry {
  const fields = buildIndexFields(s);
  const collectionGroup = s.collectionPath.split('/').pop() || s.collectionPath;
  let queryScope: 'COLLECTION' | 'COLLECTION_GROUP' = 'COLLECTION';
  if (s.isCollectionGroup) {
    queryScope = 'COLLECTION_GROUP';
  }
  return {
    collectionGroup,
    queryScope,
    fields,
  };
}

/**
 * Stable string key for an index entry used to deduplicate shapes that map
 * to the same composite index.
 */
export function indexEntryKey(e: IndexesConfigEntry): string {
  const fields = e.fields
    .map((f) => `${f.fieldPath}:${f.arrayConfig ?? f.order ?? 'ASCENDING'}`)
    .join(',');
  return `${e.queryScope}|${e.collectionGroup}|${fields}`;
}
