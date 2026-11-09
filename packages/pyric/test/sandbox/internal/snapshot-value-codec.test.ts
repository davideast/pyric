import { describe, expect, it } from 'bun:test';
import {
  Bytes,
  DocumentReference,
  GeoPoint,
  Timestamp,
  doc,
  getAdminFirestore,
  vector,
} from 'pyric/firestore';
import { Reference as RulesReference } from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import {
  decodeBase64ToBytes,
  decodeSnapshotMap,
  decodeSnapshotMapForEnv,
  encodeBytesToBase64,
  encodeSnapshotMap,
} from 'pyric/sandbox/internal';

describe('snapshot-value-codec', () => {
  it('round-trips non-finite numbers, negative zero, vectors, and nested marker-shaped user maps', () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);

    const original = {
      nanVal: Number.NaN,
      posInf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
      negZero: -0,
      embedding: vector([0.25, -0.5, 1.5]),
      ts: new Timestamp(1_700_000_000, 123_000_000),
      bytes: Bytes.fromUint8Array(new Uint8Array([0, 255, 128])),
      geo: new GeoPoint(-33.8688, 151.2093),
      ref: doc(db, 'orgs/org-1/items/item-9'),
      escapedTop: {
        type: 'pyric/map/1.0',
        fields: { keep: true },
      },
      malformedTag: {
        __type: 'reference',
        notAPath: 42,
      },
    };

    const encoded = JSON.parse(JSON.stringify(encodeSnapshotMap(original)));
    const decoded = decodeSnapshotMap(encoded, {
      create: (path) => doc(db, path),
    });

    expect(Number.isNaN(decoded.nanVal)).toBe(true);
    expect(decoded.posInf).toBe(Number.POSITIVE_INFINITY);
    expect(decoded.negInf).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(decoded.negZero, -0)).toBe(true);
    expect((decoded.embedding as ReturnType<typeof vector>).toArray()).toEqual([0.25, -0.5, 1.5]);
    expect(decoded.ts).toBeInstanceOf(Timestamp);
    expect((decoded.ts as Timestamp).isEqual(original.ts)).toBe(true);
    expect(decoded.bytes).toBeInstanceOf(Bytes);
    expect(Array.from((decoded.bytes as Bytes).toUint8Array())).toEqual([0, 255, 128]);
    expect(decoded.geo).toBeInstanceOf(GeoPoint);
    expect((decoded.geo as GeoPoint).isEqual(original.geo)).toBe(true);
    expect(decoded.ref).toBeInstanceOf(DocumentReference);
    expect((decoded.ref as DocumentReference).path).toBe('orgs/org-1/items/item-9');
    expect(decoded.escapedTop).toEqual({
      type: 'pyric/map/1.0',
      fields: { keep: true },
    });
    expect(decoded.malformedTag).toEqual({
      __type: 'reference',
      notAPath: 42,
    });
  });

  it('encodes and decodes arbitrary binary lengths without Node Buffer', () => {
    const globals = globalThis as Record<string, unknown>;
    const savedBuffer = globals.Buffer;
    try {
      delete globals.Buffer;
      for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 257]) {
        const input = new Uint8Array(length);
        for (let i = 0; i < length; i++) input[i] = (i * 73) & 0xff;
        const b64 = encodeBytesToBase64(input);
        const roundTripped = decodeBase64ToBytes(b64);
        expect(Array.from(roundTripped)).toEqual(Array.from(input));
      }
    } finally {
      globals.Buffer = savedBuffer;
    }
  });

  it('preserves non-default Reference databaseId across JSON serialization and environment decoding', () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    const analyticsRef = new RulesReference(
      'projects/demo/databases/analytics/documents/users/u1',
    );
    const defaultRef = new RulesReference('users/u1');

    const encoded = JSON.parse(
      JSON.stringify(
        encodeSnapshotMap({
          analyticsRef,
          defaultRef,
          nested: { analyticsRef },
        }),
      ),
    );

    const envDecoded = decodeSnapshotMapForEnv(encoded);
    const restoredAnalytics = envDecoded.analyticsRef as RulesReference;
    const restoredDefault = envDecoded.defaultRef as RulesReference;
    const restoredNested = (envDecoded.nested as { analyticsRef: RulesReference }).analyticsRef;
    expect(restoredAnalytics).toBeInstanceOf(RulesReference);
    expect(restoredAnalytics.path).toBe('users/u1');
    expect(restoredAnalytics.databaseId).toBe('analytics');
    expect(restoredDefault.path).toBe('users/u1');
    expect(restoredDefault.databaseId).toBe('(default)');
    expect(restoredNested.databaseId).toBe('analytics');

    const sdkDecoded = decodeSnapshotMap(encoded, {
      create: (path) => doc(db, path),
    });
    expect((sdkDecoded.analyticsRef as DocumentReference).path).toBe('users/u1');
  });

  it('guards Object.prototype property names in document fields and nested maps', () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    const original = {
      constructor: 'builder',
      toString: 'label',
      valueOf: 99,
      nested: { constructor: true, toString: 'inner' },
    };
    const encoded = JSON.parse(JSON.stringify(encodeSnapshotMap(original)));
    const sdkDecoded = decodeSnapshotMap(encoded, { create: (path) => doc(db, path) });
    const envDecoded = decodeSnapshotMapForEnv(encoded);
    expect(sdkDecoded).toEqual(original);
    expect(envDecoded).toEqual(original);
  });

  it('preserves sibling fields on hand-authored and encoded maps carrying type pyric/map/1.0 and fields', () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    const plainSeedDoc = {
      ownerId: 'u1',
      type: 'pyric/map/1.0',
      fields: { nested: 'x' },
      title: 'doc',
      sub: {
        ownerId: 'u1',
        type: 'pyric/map/1.0',
        fields: { inner: 1 },
      },
    };

    expect(decodeSnapshotMap(plainSeedDoc, { create: (path) => doc(db, path) })).toEqual(plainSeedDoc);
    expect(decodeSnapshotMapForEnv(plainSeedDoc)).toEqual(plainSeedDoc);

    const encoded = JSON.parse(JSON.stringify(encodeSnapshotMap(plainSeedDoc)));
    expect(decodeSnapshotMap(encoded, { create: (path) => doc(db, path) })).toEqual(plainSeedDoc);
    expect(decodeSnapshotMapForEnv(encoded)).toEqual(plainSeedDoc);
  });

  it('round-trips adversarial pyric/map/1.0 envelope collision shapes bijectively', () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    const refDecoder = { create: (path: string) => doc(db, path) };
    const cases: Array<{ name: string; input: Record<string, unknown> }> = [
      { name: '0 keys', input: {} },
      { name: '1 key (type only)', input: { type: 'pyric/map/1.0' } },
      { name: '2 keys (non-object fields string)', input: { type: 'pyric/map/1.0', fields: 'str' } },
      { name: '2 keys (null fields)', input: { type: 'pyric/map/1.0', fields: null } },
      { name: '2 keys (array fields)', input: { type: 'pyric/map/1.0', fields: [1, 2] } },
      { name: '2 keys (exact envelope shape)', input: { type: 'pyric/map/1.0', fields: { x: 1 } } },
      { name: '3+ keys (envelope + sibling)', input: { type: 'pyric/map/1.0', fields: { x: 1 }, sibling: 'kept' } },
      {
        name: 'nested inside arrays',
        input: {
          items: [
            { type: 'pyric/map/1.0' },
            { type: 'pyric/map/1.0', fields: 'str' },
            { type: 'pyric/map/1.0', fields: { x: 1 } },
            { type: 'pyric/map/1.0', fields: { x: 1 }, sibling: 'kept' },
          ],
        },
      },
      {
        name: 'nested inside maps',
        input: {
          outer: { type: 'pyric/map/1.0', fields: { x: 1 } },
          withSibling: { type: 'pyric/map/1.0', fields: { x: 1 }, extra: true },
        },
      },
      {
        name: 'nested inside another pyric/map/1.0 envelope',
        input: {
          type: 'pyric/map/1.0',
          fields: {
            type: 'pyric/map/1.0',
            fields: {
              x: 1,
              deep: { type: 'pyric/map/1.0', fields: { y: 2 }, sibling: 'ok' },
            },
          },
        },
      },
    ];

    for (const { input } of cases) {
      const wire = JSON.parse(JSON.stringify(encodeSnapshotMap(input)));
      expect(decodeSnapshotMap(wire, refDecoder)).toEqual(input);
      expect(decodeSnapshotMapForEnv(wire)).toEqual(input);
    }
  });
});
