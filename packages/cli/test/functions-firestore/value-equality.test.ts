import { describe, expect, test } from 'bun:test';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
  Vector as RulesVector,
} from 'pyric/rules/internal';
import {
  areFirestoreDocumentsEqual,
  areFirestoreValuesEqual,
  computeDocumentUpdateMask,
  formatFieldMaskSegment,
} from '../../src/functions/firestore/value-equality.js';

describe('value-equality & DocumentMask diffing', () => {
  test('compares Firestore scalar wrappers, special numbers, arrays, and escaped maps', () => {
    expect(areFirestoreValuesEqual(null, null)).toBe(true);
    expect(areFirestoreValuesEqual(null, undefined)).toBe(false);
    expect(areFirestoreValuesEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(areFirestoreValuesEqual(-0, 0)).toBe(false);
    expect(areFirestoreValuesEqual({ __type: 'number', value: 'NaN' }, Number.NaN)).toBe(true);
    expect(areFirestoreValuesEqual({ __type: 'number', value: '-0' }, -0)).toBe(true);

    const ts1 = new RulesTimestamp(1700000000, 123000000);
    const ts2 = { __type: 'timestamp', seconds: 1700000000, nanos: 123000000 };
    const tsVersioned = {
      type: 'firestore/timestamp/1.0',
      seconds: 1700000000,
      nanoseconds: 123000000,
    };
    expect(areFirestoreValuesEqual(ts1, ts2)).toBe(true);
    expect(areFirestoreValuesEqual(ts1, tsVersioned)).toBe(true);
    expect(areFirestoreValuesEqual(ts2, tsVersioned)).toBe(true);
    expect(areFirestoreValuesEqual(ts1, new RulesTimestamp(1700000000, 123000001))).toBe(false);
    expect(areFirestoreValuesEqual(ts1, { seconds: 1700000000, nanoseconds: 123000000 })).toBe(
      false,
    );

    const geo1 = new RulesLatLng(37.7749, -122.4194);
    const geo2 = { __type: 'geopoint', latitude: 37.7749, longitude: -122.4194 };
    const geoVersioned = {
      type: 'firestore/geoPoint/1.0',
      latitude: 37.7749,
      longitude: -122.4194,
    };
    expect(areFirestoreValuesEqual(geo1, geo2)).toBe(true);
    expect(areFirestoreValuesEqual(geo1, geoVersioned)).toBe(true);
    expect(areFirestoreValuesEqual(geo1, new RulesLatLng(37.7749, -122.0))).toBe(false);

    // High-bit bytes (>= 0xf8) produce `-` and `_` in base64url vs `+` and `/` in base64.
    const highBitBytes = Uint8Array.of(0xfb, 0xff, 0xfe);
    const rulesHighBytes = new RulesBytes(highBitBytes);
    const base64UrlMarker = {
      __type: 'bytes',
      base64: Buffer.from(highBitBytes).toString('base64url'),
    };
    const stdBase64Marker = {
      type: 'firestore/bytes/1.0',
      bytes: Buffer.from(highBitBytes).toString('base64'),
    };
    expect(base64UrlMarker.base64).toContain('-');
    expect(base64UrlMarker.base64).toContain('_');
    expect(areFirestoreValuesEqual(rulesHighBytes, base64UrlMarker)).toBe(true);
    expect(areFirestoreValuesEqual(rulesHighBytes, stdBase64Marker)).toBe(true);
    expect(areFirestoreValuesEqual(base64UrlMarker, stdBase64Marker)).toBe(true);
    expect(areFirestoreValuesEqual(base64UrlMarker, Uint8Array.of(0xfb, 0xff, 0xfd))).toBe(false);
    expect(areFirestoreValuesEqual(base64UrlMarker, new Uint8Array(0))).toBe(false);

    const ref1 = new RulesReference('users/alice', '(default)');
    const ref2 = { __type: 'reference', path: 'users/alice' };
    const refAnalytics = new RulesReference('users/alice', 'analytics');
    expect(areFirestoreValuesEqual(ref1, ref2)).toBe(true);
    expect(areFirestoreValuesEqual(ref1, refAnalytics)).toBe(false);

    const vec1 = new RulesVector([0.1, 0.2, 0.3]);
    const vec2 = { __type: 'vector', values: [0.1, 0.2, 0.3] };
    const vecVersioned = { type: 'firestore/vectorValue/1.0', vectorValues: [0.1, 0.2, 0.3] };
    const vecProtoMap = { __type__: '__vector__', value: [0.1, 0.2, 0.3] };
    expect(areFirestoreValuesEqual(vec1, vec2)).toBe(true);
    expect(areFirestoreValuesEqual(vec1, vecVersioned)).toBe(true);
    expect(areFirestoreValuesEqual(vec1, vecProtoMap)).toBe(true);
    expect(areFirestoreValuesEqual(vec1, new RulesVector([0.1, 0.2]))).toBe(false);

    const escapedUserMap = {
      type: 'pyric/map/1.0' as const,
      fields: {
        type: 'firestore/timestamp/1.0',
        seconds: 1700000000,
        nanoseconds: 123000000,
      },
    };
    expect(areFirestoreValuesEqual(escapedUserMap, tsVersioned)).toBe(false);
    expect(
      areFirestoreValuesEqual(escapedUserMap, {
        type: 'pyric/map/1.0' as const,
        fields: {
          type: 'firestore/timestamp/1.0',
          seconds: 1700000000,
          nanoseconds: 123000000,
        },
      }),
    ).toBe(true);
    expect(areFirestoreDocumentsEqual(null, null)).toBe(true);
    expect(areFirestoreDocumentsEqual({ a: 1 }, null)).toBe(false);
  });

  test('computes sorted DocumentMask field paths and treats SDK scalar markers as atomic leaves', () => {
    expect(formatFieldMaskSegment('displayName')).toBe('displayName');
    expect(formatFieldMaskSegment('a.b')).toBe('`a.b`');
    expect(formatFieldMaskSegment('quote`back\\slash')).toBe('`quote\\`back\\\\slash`');

    const before = {
      unchanged: 'same',
      count: 1,
      updatedAt: {
        type: 'firestore/timestamp/1.0',
        seconds: 100,
        nanoseconds: 0,
      },
      embedding: {
        type: 'firestore/vectorValue/1.0',
        vectorValues: [1, 2],
      },
      profile: {
        name: 'Alice',
        bio: 'old',
        keep: true,
      },
      removedTop: 'bye',
      'dot.key': 10,
    };
    const after = {
      unchanged: 'same',
      count: 2,
      updatedAt: {
        type: 'firestore/timestamp/1.0',
        seconds: 200,
        nanoseconds: 0,
      },
      embedding: {
        type: 'firestore/vectorValue/1.0',
        vectorValues: [1, 3],
      },
      profile: {
        name: 'Alice',
        bio: 'new',
        keep: true,
        addedNested: 42,
      },
      addedTop: 'hi',
      'dot.key': 20,
    };
    expect(computeDocumentUpdateMask(before, after)).toEqual([
      '`dot.key`',
      'addedTop',
      'count',
      'embedding',
      'profile.addedNested',
      'profile.bio',
      'removedTop',
      'updatedAt',
    ]);
  });
});
