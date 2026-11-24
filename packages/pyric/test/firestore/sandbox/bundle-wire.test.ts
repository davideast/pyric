import { describe, expect, it } from 'bun:test';
import { Bytes, GeoPoint, Timestamp } from '../../../src/firestore/field-values.js';
import {
  decodeBundleBytes,
  encodeBundleElements,
  parseBundleTimestamp,
  parseServerFieldPathSegments,
} from '../../../src/firestore/sandbox/bundle-wire.js';
import { VectorValue } from '../../../src/firestore/vector-value.js';

describe('bundle-wire length-prefixed JSON codec', () => {
  it('encodes and decodes metadata, named queries with composite filters, and REST value types', () => {
    const parent = 'projects/demo-wire/databases/(default)/documents';
    const body = encodeBundleElements([
      {
        namedQuery: {
          name: 'featured-items',
          bundledQuery: {
            parent: `${parent}/catalogs/main`,
            structuredQuery: {
              from: [{ collectionId: 'items', allDescendants: false }],
              where: {
                compositeFilter: {
                  op: 'OR',
                  filters: [
                    {
                      fieldFilter: {
                        field: { fieldPath: 'active' },
                        op: 'EQUAL',
                        value: { booleanValue: true },
                      },
                    },
                    {
                      fieldFilter: {
                        field: { fieldPath: 'priority' },
                        op: 'GREATER_THAN_OR_EQUAL',
                        value: { integerValue: '5' },
                      },
                    },
                  ],
                },
              },
              orderBy: [{ field: { fieldPath: 'priority' }, direction: 'DESCENDING' }],
              limit: { value: 10 },
            },
            limitType: 'LAST',
          },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/catalogs/main/items/item-1`,
          exists: true,
          queries: ['featured-items'],
        },
      },
      {
        document: {
          name: `${parent}/catalogs/main/items/item-1`,
          fields: {
            label: { stringValue: 'Featured' },
            active: { booleanValue: true },
            priority: { integerValue: '7' },
            ratio: { doubleValue: 1.5 },
            empty: { nullValue: null },
            when: { timestampValue: '2026-01-15T12:00:00.123456789Z' },
            protoWhen: { timestampValue: { seconds: '1700000000', nanos: 987654321 } },
            embedding: {
              mapValue: {
                fields: {
                  __type__: { stringValue: '__vector__' },
                  value: { arrayValue: { values: [{ doubleValue: 0.25 }, { doubleValue: -1.5 }] } },
                },
              },
            },
            blob: { bytesValue: 'AQID' },
            coords: { geoPointValue: { latitude: 37.7, longitude: -122.4 } },
            tags: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
            nested: { mapValue: { fields: { flag: { booleanValue: false } } } },
          },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/catalogs/main/items/missing-1`,
          exists: false,
          queries: [],
        },
      },
    ]);
    const totalBytes = new TextEncoder().encode(body).byteLength;
    const header = encodeBundleElements([
      { metadata: { id: 'bundle-wire-1', version: 1, totalDocuments: 2, totalBytes: String(totalBytes) } },
    ]);
    const parsed = decodeBundleBytes(new TextEncoder().encode(header + body));

    expect(parsed.id).toBe('bundle-wire-1');
    expect(parsed.totalDocuments).toBe(2);
    expect(parsed.totalBytes).toBe(totalBytes);
    expect(parsed.namedQueries).toHaveLength(1);
    expect(parsed.namedQueries[0]).toMatchObject({
      name: 'featured-items',
      collectionPath: 'catalogs/main/items',
      isCollectionGroup: false,
      limitCount: 10,
      limitType: 'LAST',
      orders: [{ fieldPath: 'priority', direction: 'desc' }],
    });
    expect(parsed.documents).toHaveLength(2);
    const first = parsed.documents[0];
    expect(first?.exists).toBe(true);
    expect(first?.docPath).toBe('catalogs/main/items/item-1');
    expect(first?.data?.when).toBeInstanceOf(Timestamp);
    expect((first?.data?.when as Timestamp | undefined)?.nanoseconds).toBe(123_456_789);
    expect((first?.data?.protoWhen as Timestamp | undefined)?.seconds).toBe(1_700_000_000);
    expect((first?.data?.protoWhen as Timestamp | undefined)?.nanoseconds).toBe(987_654_321);
    expect(first?.data?.embedding).toBeInstanceOf(VectorValue);
    expect((first?.data?.embedding as VectorValue | undefined)?.toArray()).toEqual([0.25, -1.5]);
    expect(first?.data?.blob).toBeInstanceOf(Bytes);
    expect(first?.data?.coords).toBeInstanceOf(GeoPoint);
    expect(first?.data?.tags).toEqual(['a', 'b']);
    expect(first?.data?.nested).toEqual({ flag: false });
    expect(parsed.documents[1]?.exists).toBe(false);
    expect(parsed.documents[1]?.bytesLoadedAfterDoc).toBe(totalBytes);
  });

  it('decodes unaryFilter (IS_NULL, IS_NOT_NULL, IS_NAN, IS_NOT_NAN), startAt/endAt cursors, and server field paths', () => {
    const parent = 'projects/demo-wire/databases/(default)/documents';
    const body = encodeBundleElements([
      {
        namedQuery: {
          name: 'cursor-and-unary',
          readTime: { seconds: '1700000010', nanos: 500 },
          bundledQuery: {
            parent,
            structuredQuery: {
              from: [{ collectionId: 'metrics' }],
              where: {
                compositeFilter: {
                  op: 'AND',
                  filters: [
                    { unaryFilter: { field: { fieldPath: 'archivedAt' }, op: 'IS_NULL' } },
                    { unaryFilter: { field: { fieldPath: '`score.raw`' }, op: 'IS_NOT_NAN' } },
                  ],
                },
              },
              orderBy: [{ field: { fieldPath: '`score.raw`' }, direction: 'ASCENDING' }],
              startAt: { before: true, values: [{ integerValue: '10' }] },
              endAt: { before: true, values: [{ integerValue: '50' }] },
            },
          },
        },
      },
    ]);
    const header = encodeBundleElements([
      {
        metadata: {
          id: 'bundle-wire-unary',
          createTime: { seconds: '1700000010', nanos: 500 },
          version: 1,
          totalDocuments: 0,
          totalBytes: new TextEncoder().encode(body).byteLength,
        },
      },
    ]);
    const parsed = decodeBundleBytes(new TextEncoder().encode(header + body));
    expect(parsed.createTime?.seconds).toBe(1_700_000_010);
    expect(parsed.createTime?.nanoseconds).toBe(500);
    const nq = parsed.namedQueries[0];
    expect(nq?.filters).toEqual([
      {
        kind: 'and',
        filters: [
          { kind: 'where', fieldPath: 'archivedAt', fieldSegments: ['archivedAt'], op: '==', value: null },
          {
            kind: 'where',
            fieldPath: '`score.raw`',
            fieldSegments: ['score.raw'],
            op: '!=',
            value: Number.NaN,
          },
        ],
      },
    ]);
    expect(nq?.startAt).toEqual({ inclusive: true, values: [10] });
    expect(nq?.endAt).toEqual({ inclusive: false, values: [50] });
    expect(parseServerFieldPathSegments('a.`b.c`.d')).toEqual(['a', 'b.c', 'd']);
    expect(parseBundleTimestamp('1969-12-31T23:59:59.123456789Z')?.seconds).toBe(-1);
    expect(parseBundleTimestamp('1969-12-31T23:59:59.123456789Z')?.nanoseconds).toBe(123_456_789);
  });

  it('throws plain Error on empty or malformed length-prefixed payloads', () => {
    expect(() => decodeBundleBytes(new Uint8Array(0))).toThrow(Error);
    expect(() => decodeBundleBytes(new TextEncoder().encode('invalid'))).toThrow(Error);
    expect(() => decodeBundleBytes(new TextEncoder().encode('2{}'))).toThrow(Error);
  });
});
