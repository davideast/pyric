import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore, Timestamp, WriteResult } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore reference back-pointers and snapshot timestamps/equality', () => {
  it('exposes .firestore, .parent, .isEqual, and monotonic snapshot timestamps', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'ref-eq-app');
    const db = getFirestore(app);
    const rootCol = db.collection('items') as ReturnType<typeof db.collection> & {
      readonly firestore: unknown;
      readonly parent: { path: string } | null;
      isEqual(other: unknown): boolean;
    };
    const subCol = db.collection('items/d1/children') as typeof rootCol;
    expect(rootCol.parent).toBeNull();
    expect(subCol.parent?.path).toBe('items/d1');
    expect(rootCol.firestore).toBe(db);
    expect(rootCol.isEqual(db.collection('items'))).toBe(true);
    expect(rootCol.isEqual(subCol)).toBe(false);

    const d1 = db.doc('items/d1') as ReturnType<typeof db.doc> & {
      readonly firestore: unknown;
      isEqual(other: unknown): boolean;
    };
    expect(d1.firestore).toBe(db);
    expect(d1.isEqual(rootCol.doc('d1'))).toBe(true);

    const wr1 = await d1.create({ title: 'v1', rank: 1 });
    expect(wr1 instanceof WriteResult).toBe(true);

    const s1a = (await d1.get()) as Awaited<ReturnType<typeof d1.get>> & {
      createTime: Timestamp | undefined;
      updateTime: Timestamp | undefined;
      readTime: Timestamp;
      isEqual(other: unknown): boolean;
    };
    const s1b = (await d1.get()) as typeof s1a;
    expect(s1a.createTime instanceof Timestamp).toBe(true);
    expect(s1a.createTime?.isEqual(wr1.writeTime)).toBe(true);
    expect(s1a.isEqual(s1b)).toBe(true);

    await d1.update({ title: 'v2' });
    const s2 = (await d1.get()) as typeof s1a;
    expect(s2.createTime?.isEqual(s1a.createTime as Timestamp)).toBe(true);
    expect(s1a.isEqual(s2)).toBe(false);
  });
});
