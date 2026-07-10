import { describe, expect, it } from 'bun:test';
import { Bytes, GeoPoint, Timestamp } from 'pyric/firestore';
import { firestoreValuesEqual } from '../../../src/firestore/valueEquality.js';

describe('firestoreValuesEqual', () => {
  it('compares nested maps and arrays structurally', () => {
    expect(
      firestoreValuesEqual(
        { title: 'hello', sections: [{ published: true }] },
        { title: 'hello', sections: [{ published: true }] },
      ),
    ).toBe(true);
    expect(firestoreValuesEqual({ count: 1 }, { count: 2 })).toBe(false);
  });

  it('uses Firestore value equality for SDK types', () => {
    const previous = {
      createdAt: Timestamp.fromMillis(1_000),
      location: new GeoPoint(37.7, -122.4),
      payload: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
    };
    const next = {
      createdAt: Timestamp.fromMillis(1_000),
      location: new GeoPoint(37.7, -122.4),
      payload: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
    };

    expect(firestoreValuesEqual(previous, next)).toBe(true);
    expect(
      firestoreValuesEqual(previous, {
        ...next,
        location: new GeoPoint(40.7, -74),
      }),
    ).toBe(false);
  });

  it('compares worker-serialized byte arrays by content', () => {
    expect(
      firestoreValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])),
    ).toBe(true);
    expect(
      firestoreValuesEqual(new Uint8Array([1, 2]), new Uint8Array([2, 1])),
    ).toBe(false);
  });
});
