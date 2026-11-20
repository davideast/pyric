import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { GeoPoint, getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore GeoPoint', () => {
  it('exposes latitude, longitude, isEqual, and validates coordinate bounds', () => {
    const sf = new GeoPoint(37.7749, -122.4194);
    expect(sf.latitude).toBe(37.7749);
    expect(sf.longitude).toBe(-122.4194);
    expect(sf.isEqual(new GeoPoint(37.7749, -122.4194))).toBe(true);
    expect(sf.isEqual(new GeoPoint(0, 0))).toBe(false);

    expect(() => new GeoPoint(Number.NaN, 0)).toThrow(/latitude.*not a valid number/);
    expect(() => new GeoPoint(90.1, 0)).toThrow(/within \[-90, 90\] inclusive/);
    expect(() => new GeoPoint(-90.1, 0)).toThrow(/within \[-90, 90\] inclusive/);
    expect(() => new GeoPoint(0, 180.1)).toThrow(/within \[-180, 180\] inclusive/);
    expect(() => new GeoPoint(0, -180.1)).toThrow(/within \[-180, 180\] inclusive/);
  });

  it('round-trips GeoPoint instances through set and get', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'geo-app');
    const db = getFirestore(app);
    const pt = new GeoPoint(48.8566, 2.3522);
    await db.doc('places/paris').set({ coords: pt });
    const snap = await db.doc('places/paris').get();
    const out = snap.data()?.coords;
    expect(out).toBeInstanceOf(GeoPoint);
    expect((out as GeoPoint).isEqual(pt)).toBe(true);
  });
});
