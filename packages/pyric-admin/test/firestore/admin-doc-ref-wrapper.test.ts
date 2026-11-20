import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore DocumentReference wrapper', () => {
  it('exposes synthetic descriptor properties for surface audit and resets converter with null', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'doc-wrap-app');
    const db = getFirestore(app);
    const ref = db.doc('items/x') as ReturnType<typeof db.doc> & {
      withConverter(c: unknown): typeof ref;
    };
    expect('firestore' in ref).toBe(true);
    expect('isEqual' in ref).toBe(true);
    expect('listCollections' in ref).toBe(true);
    expect('withConverter' in ref).toBe(true);
    const resetRef = ref.withConverter(null);
    expect((resetRef as unknown as { isEqual(o: unknown): boolean }).isEqual(ref)).toBe(true);
  });
});
