import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore getAll, listCollections, and recursiveDelete', () => {
  it('fetches ordered snapshots with optional fieldMask and rejects zero-arg getAll()', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'maint-app');
    const db = getFirestore(app) as ReturnType<typeof getFirestore> & {
      getAll(...args: unknown[]): Promise<Array<{ id: string; exists: boolean; data(): Record<string, unknown> | undefined }>>;
      listCollections(): Promise<Array<{ id: string }>>;
      recursiveDelete(ref: unknown): Promise<void>;
    };

    await db.doc('items/a').set({ title: 'Alpha', rank: 1 });
    await db.doc('items/b').set({ title: 'Beta', rank: 2 });

    const ordered = await db.getAll(db.doc('items/b'), db.doc('items/missing'), db.doc('items/a'));
    expect(ordered.map((s) => s.id)).toEqual(['b', 'missing', 'a']);
    expect(ordered.map((s) => s.exists)).toEqual([true, false, true]);

    const masked = await db.getAll(db.doc('items/a'), { fieldMask: ['title'] });
    expect(masked[0]?.data()).toEqual({ title: 'Alpha' });
    expect(await db.getAll({})).toEqual([]);
    expect((await db.getAll(db.doc('items/a'), {}))[0]?.id).toBe('a');

    for (const badArgs of [[], [[db.doc('items/a')]], [db.doc('items/a'), { fieldMask: ['a..b'] }]]) {
      let threw = false;
      try {
        await db.getAll(...badArgs);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }

    await db.doc('alpha/d1').set({ v: 1 });
    const cols = await db.listCollections();
    expect(cols.map((c) => c.id)).toEqual(['alpha', 'items']);

    await db.doc('tree/root').set({ level: 0 });
    await db.doc('tree/root/sub/leaf').set({ level: 1 });
    await db.doc('tree/sibling').set({ keep: true });
    await db.recursiveDelete(db.doc('tree/root'));
    expect((await db.doc('tree/root').get()).exists).toBe(false);
    expect((await db.doc('tree/root/sub/leaf').get()).exists).toBe(false);
    expect((await db.doc('tree/sibling').get()).exists).toBe(true);
  });
});
