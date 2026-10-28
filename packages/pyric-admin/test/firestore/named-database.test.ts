/**
 * Production `getFirestore(app, databaseId)` returns an Admin handle bound to
 * that named database. The admin sandbox has no database id parameter: every
 * call resolves to the app's `(default)` database.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** The production two-argument signature, which the admin sandbox does not declare. */
const getFirestoreWithDatabaseId = getFirestore as unknown as (
  app: unknown,
  databaseId: string,
) => ReturnType<typeof getFirestore>;

describe('getFirestore(app, databaseId)', () => {
  test('ignores the database id and shares the (default) database', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    await getFirestoreWithDatabaseId(app, 'reports').doc('items/one').set({ from: 'reports' });

    expect((await getFirestore(app).doc('items/one').get()).data()).toEqual({ from: 'reports' });
    expect((await getFirestoreWithDatabaseId(app, 'archive').doc('items/one').get()).data()).toEqual({ from: 'reports' });
  });
});
