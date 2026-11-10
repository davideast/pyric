import { describe, expect, it } from 'bun:test';
import { Bytes, GeoPoint, Timestamp, doc, getAdminFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { rehydrateFirestoreDocData } from '../../../src/serve/observed-session/rehydrate.js';

describe('rehydrateFirestoreDocData', () => {
  it('rehydrates Timestamp, GeoPoint, Bytes, VectorValue, and DocumentReference instances', () => {
    const sandbox = initializeSandbox();
    const adminDb = getAdminFirestore(sandbox);
    const hydrated = rehydrateFirestoreDocData(adminDb, {
      ts: { seconds: 1700000000, nanoseconds: 250 },
      geo: { latitude: 40.7128, longitude: -74.006 },
      bin: { type: 'firestore/bytes/1.0', bytes: 'AQID' },
      vec: { __type__: '__vector__', value: [1, 2, 3] },
      ref: { type: 'document', path: 'users/ada', id: 'ada' },
      nested: { plain: { n: 1 } },
    });
    expect(hydrated.ts).toBeInstanceOf(Timestamp);
    expect(hydrated.geo).toBeInstanceOf(GeoPoint);
    expect(hydrated.bin).toBeInstanceOf(Bytes);
    expect((hydrated.vec as { toArray: () => number[] }).toArray()).toEqual([1, 2, 3]);
    expect((hydrated.ref as ReturnType<typeof doc>).path).toBe('users/ada');
    expect(hydrated.nested).toEqual({ plain: { n: 1 } });
  });

  it('unwraps pyric/map/1.0 envelopes as plain maps instead of coercing colliding shapes into SDK special values', () => {
    const sandbox = initializeSandbox();
    const adminDb = getAdminFirestore(sandbox);
    const hydrated = rehydrateFirestoreDocData(adminDb, {
      coordsMap: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
      spanMap: { type: 'pyric/map/1.0', fields: { seconds: 30, nanoseconds: 0 } },
      linkMap: { type: 'pyric/map/1.0', fields: { type: 'document', path: 'orgs/o1', id: 'o1' } },
      escapedEnvelopeMap: {
        type: 'pyric/map/1.0',
        fields: { type: 'pyric/map/1.0', fields: { label: 'literal' } },
      },
    });
    expect(hydrated.coordsMap).not.toBeInstanceOf(GeoPoint);
    expect(hydrated.coordsMap).toEqual({ latitude: 12.5, longitude: 42.25 });
    expect(hydrated.spanMap).not.toBeInstanceOf(Timestamp);
    expect(hydrated.spanMap).toEqual({ seconds: 30, nanoseconds: 0 });
    expect(hydrated.linkMap).toEqual({ type: 'document', path: 'orgs/o1', id: 'o1' });
    expect(Object.getPrototypeOf(hydrated.linkMap)).toBe(Object.prototype);
    expect(hydrated.escapedEnvelopeMap).toEqual({ type: 'pyric/map/1.0', fields: { label: 'literal' } });

    const rootGeoLike = rehydrateFirestoreDocData(adminDb, {
      latitude: 12.5,
      longitude: 42.25,
    });
    expect(rootGeoLike).not.toBeInstanceOf(GeoPoint);
    expect(rootGeoLike).toEqual({ latitude: 12.5, longitude: 42.25 });
  });
});
