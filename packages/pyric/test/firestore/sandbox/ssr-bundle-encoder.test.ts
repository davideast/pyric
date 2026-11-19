import { describe, expect, it } from 'bun:test';
import { Bytes, GeoPoint, Timestamp } from '../../../src/firestore/field-values.js';
import { decodeBundleBytes } from '../../../src/firestore/sandbox/bundle-wire.js';
import {
  encodeDocumentSnapshotJson,
  encodeQuerySnapshotJson,
} from '../../../src/firestore/sandbox/ssr-bundle-encoder.js';

describe('ssr-bundle-encoder', () => {
  it('encodes existing and missing DocumentSnapshot envelopes matching firebase/firestore@12.19.0', () => {
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
      stamped: Timestamp.fromMillis(1_700_000_000_000),
      payload: Bytes.fromUint8Array(new Uint8Array([1, 2])),
      point: new GeoPoint(12, 34),
    });
    expect(existing.type).toBe('firestore/documentSnapshot/1.0');
    expect(existing.bundleSource).toBe('DocumentSnapshot');
    expect(existing.bundleName).toBe('articles/alpha');
    const decoded = decodeBundleBytes(new TextEncoder().encode(existing.bundle));
    expect(decoded.totalDocuments).toBe(1);
    expect(decoded.documents[0]?.docPath).toBe('articles/alpha');
    expect(decoded.documents[0]?.data?.title).toBe('Hello');
    expect(decoded.documents[0]?.data?.count).toBe(3);
  });

  it('encodes QuerySnapshot envelopes with structuredQuery filters, orders, and limits', () => {
    const env = encodeQuerySnapshotJson(
      'demo-proj',
      {
        collectionPath: 'shops/s1/orders',
        isCollectionGroup: false,
        filters: [
          { kind: 'where', fieldPath: 'status', op: '==', value: 'paid' },
          { kind: 'where', fieldPath: 'total', op: '>=', value: 10 },
        ],
        orders: [{ fieldPath: 'total', direction: 'desc' }],
        limitCount: 5,
        limitType: 'FIRST',
      },
      [{ path: 'shops/s1/orders/o1', data: { status: 'paid', total: 25 } }],
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
      orders: [{ fieldPath: 'total', direction: 'desc' }],
    });
    expect(decoded.documents[0]?.docPath).toBe('shops/s1/orders/o1');
  });
});
