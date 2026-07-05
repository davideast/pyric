/**
 * Unit tests for needsCompositeIndex + shapeToIndexEntry + indexEntryKey.
 */
import { describe, test, expect } from 'bun:test';
import {
  needsCompositeIndex,
  shapeToIndexEntry,
  indexEntryKey,
} from '../../../../src/rules/indexes/extract/composite.js';
import type { QueryShape } from '../../../../src/rules/indexes/extract/types.js';

const shape = (overrides: Partial<QueryShape> = {}): QueryShape => ({
  collectionPath: 'restaurants',
  isCollectionGroup: false,
  filters: [],
  orders: [],
  limit: null,
  ...overrides,
});

describe('needsCompositeIndex — no-composite cases', () => {
  test('zero filters, zero orders → false', () => {
    expect(needsCompositeIndex(shape())).toBe(false);
  });

  test('one equality filter only → false (single-field handles it)', () => {
    expect(needsCompositeIndex(shape({
      filters: [{ field: 'a', op: '==' }],
    }))).toBe(false);
  });

  test('one orderBy only → false', () => {
    expect(needsCompositeIndex(shape({
      orders: [{ field: 'a', direction: 'asc' }],
    }))).toBe(false);
  });

  test('equality + orderBy on same field → false', () => {
    expect(needsCompositeIndex(shape({
      filters: [{ field: 'a', op: '==' }],
      orders: [{ field: 'a', direction: 'desc' }],
    }))).toBe(false);
  });
});

describe('needsCompositeIndex — composite cases', () => {
  test('two equality filters → true', () => {
    expect(needsCompositeIndex(shape({
      filters: [{ field: 'a', op: '==' }, { field: 'b', op: '==' }],
    }))).toBe(true);
  });

  test('equality + orderBy on different field → true', () => {
    expect(needsCompositeIndex(shape({
      filters: [{ field: 'a', op: '==' }],
      orders: [{ field: 'b', direction: 'desc' }],
    }))).toBe(true);
  });

  test('range + orderBy on different field → true', () => {
    expect(needsCompositeIndex(shape({
      filters: [{ field: 'a', op: '>' }],
      orders: [{ field: 'b', direction: 'asc' }],
    }))).toBe(true);
  });

  test('two orderBys → true', () => {
    expect(needsCompositeIndex(shape({
      orders: [{ field: 'a', direction: 'asc' }, { field: 'b', direction: 'desc' }],
    }))).toBe(true);
  });

  test('array-contains treated as equality — array-contains + orderBy on different field → true', () => {
    expect(needsCompositeIndex(shape({
      filters: [{ field: 'tags', op: 'array-contains' }],
      orders: [{ field: 'createdAt', direction: 'desc' }],
    }))).toBe(true);
  });
});

describe('shapeToIndexEntry — field ordering', () => {
  test('equality filters come before orderBy fields', () => {
    const e = shapeToIndexEntry(shape({
      filters: [{ field: 'category', op: '==' }],
      orders: [{ field: 'rating', direction: 'desc' }],
    }));
    expect(e.fields).toEqual([
      { fieldPath: 'category', order: 'ASCENDING' },
      { fieldPath: 'rating', order: 'DESCENDING' },
    ]);
  });

  test('orderBy on a field already in filters wins direction', () => {
    const e = shapeToIndexEntry(shape({
      filters: [{ field: 'rating', op: '>' }],
      orders: [{ field: 'rating', direction: 'desc' }],
    }));
    expect(e.fields).toHaveLength(1);
    expect(e.fields[0]).toEqual({ fieldPath: 'rating', order: 'DESCENDING' });
  });

  test('multiple equality filters keep source order', () => {
    const e = shapeToIndexEntry(shape({
      filters: [{ field: 'a', op: '==' }, { field: 'b', op: '==' }],
    }));
    expect(e.fields.map(f => f.fieldPath)).toEqual(['a', 'b']);
  });

  test('range filters come after equality', () => {
    const e = shapeToIndexEntry(shape({
      filters: [
        { field: 'category', op: '==' },
        { field: 'price', op: '>' },
      ],
    }));
    expect(e.fields[0].fieldPath).toBe('category');
    expect(e.fields[1].fieldPath).toBe('price');
  });

  test('collectionGroup uses last path segment for subcollections', () => {
    const e = shapeToIndexEntry(shape({
      collectionPath: 'users/{*}/posts',
      filters: [{ field: 'a', op: '==' }, { field: 'b', op: '==' }],
    }));
    expect(e.collectionGroup).toBe('posts');
  });

  test('isCollectionGroup → queryScope COLLECTION_GROUP', () => {
    const e = shapeToIndexEntry(shape({
      isCollectionGroup: true,
      filters: [{ field: 'a', op: '==' }],
      orders: [{ field: 'b', direction: 'asc' }],
    }));
    expect(e.queryScope).toBe('COLLECTION_GROUP');
  });
});

describe('indexEntryKey — dedupe identity', () => {
  test('same scope + group + fields + order → same key', () => {
    const a = shapeToIndexEntry(shape({
      filters: [{ field: 'category', op: '==' }],
      orders: [{ field: 'rating', direction: 'desc' }],
    }));
    const b = shapeToIndexEntry(shape({
      filters: [{ field: 'category', op: '==' }],
      orders: [{ field: 'rating', direction: 'desc' }],
    }));
    expect(indexEntryKey(a)).toBe(indexEntryKey(b));
  });

  test('different field order → different key', () => {
    const a = shapeToIndexEntry(shape({
      filters: [{ field: 'a', op: '==' }, { field: 'b', op: '==' }],
    }));
    const b = shapeToIndexEntry(shape({
      filters: [{ field: 'b', op: '==' }, { field: 'a', op: '==' }],
    }));
    expect(indexEntryKey(a)).not.toBe(indexEntryKey(b));
  });
});
