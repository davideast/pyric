import { describe, expect, it } from 'bun:test';
import { Bytes, GeoPoint, Timestamp } from '../../../src/firestore/field-values.js';
import { decodeBundleBytes } from '../../../src/firestore/sandbox/bundle-wire.js';
import {
  encodeDocumentSnapshotJson,
  encodeQuerySnapshotJson,
} from '../../../src/firestore/sandbox/ssr-bundle-encoder.js';
import { VectorValue } from '../../../src/firestore/vector-value.js';

describe('ssr-bundle-encoder', () => {
  it('encodes existing and missing DocumentSnapshot envelopes with nanosecond timestamps, vectors, and special floats', () => {
    const missing = encodeDocumentSnapshotJson('demo-proj', 'articles/ghost', false, undefined);
    expect(missing).toEqual({
      type: 'firestore/documentSnapshot/1.0',
      bundle: '',
      bundleSource: 'DocumentSnapshot',
      bundleName: 'articles/ghost',
    });

    const existing = encodeDocumentSnapshotJson('demo-proj', 'articles/alpha', true, {
      title: 'Hello',
      count: 3,
      score: 4.5,
      nanVal: Number.NaN,
      posInf: Infinity,
      negInf: -Infinity,
      negZero: -0,
      stamped: new Timestamp(1_700_000_000, 123_456_789),
      embedding: VectorValue.create([1.25, -3.5]),
      payload: Bytes.fromUint8Array(new Uint8Array([1, 2])),
      point: new GeoPoint(12, 34),
    });
    expect(existing.type).toBe('firestore/documentSnapshot/1.0');
    expect(existing.bundleSource).toBe('DocumentSnapshot');
    expect(existing.bundleName).toBe('articles/alpha');
    const decoded = decodeBundleBytes(new TextEncoder().encode(existing.bundle));
    expect(decoded.totalDocuments).toBe(1);
    const docData = decoded.documents[0]?.data;
    expect(decoded.documents[0]?.docPath).toBe('articles/alpha');
    expect(docData?.title).toBe('Hello');
    expect(docData?.count).toBe(3);
    expect(Number.isNaN(docData?.nanVal as number)).toBe(true);
    expect(docData?.posInf).toBe(Infinity);
    expect(docData?.negInf).toBe(-Infinity);
    expect(Object.is(docData?.negZero, -0)).toBe(true);
    expect((docData?.stamped as Timestamp | undefined)?.nanoseconds).toBe(123_456_789);
    expect((docData?.embedding as VectorValue | undefined)?.toArray()).toEqual([1.25, -3.5]);
  });

  it('encodes QuerySnapshot envelopes with unary filters, escaped field paths, cursors, orders, and limits', () => {
    const env = encodeQuerySnapshotJson(
      'demo-proj',
      {
        collectionPath: 'shops/s1/orders',
        isCollectionGroup: false,
        filters: [
          { kind: 'where', fieldPath: 'deletedAt', fieldSegments: ['deletedAt'], op: '==', value: null },
          { kind: 'where', fieldPath: '`net.total`', fieldSegments: ['net.total'], op: '>=', value: 10 },
        ],
        orders: [{ fieldPath: '`net.total`', fieldSegments: ['net.total'], direction: 'desc' }],
        limitCount: 5,
        limitType: 'FIRST',
        startAt: { inclusive: false, values: [100] },
        endAt: { inclusive: true, values: [10] },
      },
      [{ path: 'shops/s1/orders/o1', data: { deletedAt: null, 'net.total': 25 } }],
    );
    expect(env.type).toBe('firestore/querySnapshot/1.0');
    expect(env.bundleSource).toBe('QuerySnapshot');
    const decoded = decodeBundleBytes(new TextEncoder().encode(env.bundle));
    expect(decoded.namedQueries[0]).toMatchObject({
      name: env.bundleName,
      collectionPath: 'shops/s1/orders',
      isCollectionGroup: false,
      limitCount: 5,
      limitType: 'FIRST',
      orders: [{ fieldPath: '`net.total`', fieldSegments: ['net.total'], direction: 'desc' }],
      startAt: { inclusive: false, values: [100] },
      endAt: { inclusive: true, values: [10] },
    });
    expect(decoded.documents[0]?.docPath).toBe('shops/s1/orders/o1');
  });
});
