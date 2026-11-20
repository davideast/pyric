import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore as getClientFirestore, loadBundle, namedQuery, getDocs } from 'pyric/firestore';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';
import type { AdminBundleBuilder } from '../../src/firestore/admin-bundle-builder.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore bundle()', () => {
  it('builds length-prefixed Buffer bundles consumable by pyric/firestore loadBundle', async () => {
    const sourceSandbox = initializeSandbox({ projectId: 'demo-bundle' });
    const app = initializeApp({ sandbox: sourceSandbox, projectId: 'demo-bundle' }, 'bundle-app');
    const db = getFirestore(app) as ReturnType<typeof getFirestore> & {
      bundle(id?: string): AdminBundleBuilder;
    };

    await db.doc('items/one').set({ tag: 'first', rank: 1 });
    await db.doc('items/two').set({ tag: 'second', rank: 2 });
    const single = await db.doc('items/one').get();
    const allItems = await db.collection('items').get();

    const buf = db.bundle('admin-items-bundle').add(single).add('all-items', allItems).build();
    expect(Buffer.isBuffer(buf)).toBe(true);

    const targetSandbox = initializeSandbox({ projectId: 'demo-bundle' });
    setRules(
      targetSandbox,
      "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if true; } } }",
    );
    const clientDb = getClientFirestore(targetSandbox);
    const progress = await loadBundle(clientDb, buf);
    expect(progress.totalDocuments).toBe(2);
    const named = await namedQuery(clientDb, 'all-items');
    expect(named).not.toBeNull();
    if (named !== null) {
      const snap = await getDocs(named);
      expect(snap.size).toBe(2);
    }
  });
});
