import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore, initializeFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore initializeFirestore, settings, and terminate', () => {
  it('returns cached app handle from initializeFirestore and enforces single settings() call', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'settings-app');
    const db = initializeFirestore(app, { preferRest: false });
    expect(db).toBe(getFirestore(app));
    expect(initializeFirestore(app, { preferRest: false })).toBe(db);

    const app2 = initializeApp({ sandbox: initializeSandbox() }, 'ignore-undef');
    const db2 = getFirestore(app2);
    (db2 as unknown as { settings(s: Record<string, unknown>): void }).settings({
      ignoreUndefinedProperties: true,
    });
    expect(() =>
      (db2 as unknown as { settings(s: Record<string, unknown>): void }).settings({
        ignoreUndefinedProperties: false,
      }),
    ).toThrow(/already been initialized/);

    await db2.doc('items/one').set({ present: 'ok', omitted: undefined } as Record<string, unknown>);
    const snap = await db2.doc('items/one').get();
    expect(Object.keys(snap.data() ?? {})).toEqual(['present']);
  });

  it('rejects post-terminate operations while getFirestore(app) returns the same handle', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'term-app');
    const db = getFirestore(app);
    await (db as unknown as { terminate(): Promise<void> }).terminate();
    expect(getFirestore(app)).toBe(db);

    let caught: unknown = null;
    try {
      await db.doc('items/after-term').set({ x: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('terminated');
  });
});
