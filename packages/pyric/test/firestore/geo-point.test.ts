import { describe, expect, it } from 'bun:test';
import { FirebaseError as UpstreamFirebaseError } from 'firebase/app';
import { GeoPoint as UpstreamGeoPoint } from 'firebase/firestore';
import { FirebaseError } from 'pyric/app';
import { FirestoreError, GeoPoint } from 'pyric/firestore';

describe('GeoPoint invalid-argument errors (#1973)', () => {
  it('throws FirebaseError(invalid-argument) with upstream messages for out-of-range, NaN, and malformed JSON inputs', () => {
    const invalidCoords: ReadonlyArray<readonly [number, number]> = [
      [Number.NaN, 0],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
      [-90.001, 0],
      [90.001, 0],
      [0, -180.001],
      [0, 180.001],
    ];

    for (const [lat, lng] of invalidCoords) {
      let upErr: unknown;
      let pyErr: unknown;
      try {
        new UpstreamGeoPoint(lat, lng);
      } catch (error) {
        upErr = error;
      }
      try {
        new GeoPoint(lat, lng);
      } catch (error) {
        pyErr = error;
      }
      expect(upErr).toBeInstanceOf(UpstreamFirebaseError);
      expect(pyErr).toBeInstanceOf(FirebaseError);
      expect(pyErr).not.toBeInstanceOf(TypeError);
      expect(pyErr).not.toBeInstanceOf(FirestoreError);
      expect((pyErr as FirebaseError).code).toBe('invalid-argument');
      expect((pyErr as FirebaseError).message).toBe((upErr as UpstreamFirebaseError).message);
    }

    const invalidJsonCases: readonly unknown[] = [
      null,
      {},
      { type: 'wrong', latitude: 0, longitude: 0 },
      { type: 'firestore/geoPoint/1.0', latitude: '0', longitude: 0 },
      { type: 'firestore/geoPoint/1.0', latitude: 95, longitude: 0 },
    ];
    for (const badJson of invalidJsonCases) {
      let upErr: unknown;
      let pyErr: unknown;
      try {
        UpstreamGeoPoint.fromJSON(badJson as object);
      } catch (error) {
        upErr = error;
      }
      try {
        GeoPoint.fromJSON(badJson as object);
      } catch (error) {
        pyErr = error;
      }
      expect(upErr).toBeInstanceOf(UpstreamFirebaseError);
      expect(pyErr).toBeInstanceOf(FirebaseError);
      expect(pyErr).not.toBeInstanceOf(TypeError);
      expect((pyErr as FirebaseError).code).toBe('invalid-argument');
      expect((pyErr as FirebaseError).message).toBe((upErr as UpstreamFirebaseError).message);
    }

    const valid = new GeoPoint(37.7749, -122.4194);
    expect(GeoPoint.fromJSON(valid.toJSON()).isEqual(valid)).toBe(true);
  });
});
