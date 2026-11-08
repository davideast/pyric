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
});
