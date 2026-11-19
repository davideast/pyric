/**
 * RTDB modular SDK — root primitive write (T4-7 / DB-B13).
 *
 * `set(ref(db), 'hello')` (a primitive at the root) is legal in prod —
 * the sandbox previously threw "Root write must be an object". A
 * subsequent child write replaces the primitive root ("writes win").
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  getAdminDatabase,
  ref,
  set,
  setWithPriority,
  setPriority,
  update,
  remove,
  runTransaction,
  onValue,
  get,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';
import { load, setup } from './oracle-conformance.support.js';

describe('DB-B13 — root primitive write', () => {
  it('set(ref(db), primitive) stores the primitive at the root', async () => {
    const { db } = setup();
    await set(ref(db), 'hello');
    const snap = await get(ref(db));
    expect(snap.val()).toBe('hello');
    expect(snap.exists()).toBe(true);
  });

  it('a child write replaces a primitive root (writes win)', async () => {
    const { db } = setup();
    await set(ref(db), 'hello');
    await set(ref(db, 'a'), 1);
    const snap = await get(ref(db));
    expect(snap.val()).toEqual({ a: 1 });
  });

  it('evaluates security rules across client operations when root holds bare scalar primitives', async () => {
    const sb = initializeSandbox();
    try {
      const clientDb = getDatabase(sb.withAuth({ uid: 'u1', token: {} }));
      const adminDb = getAdminDatabase(sb);
      rtdbSandbox.setRules(clientDb, {
        rules: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      });

      await setWithPriority(ref(adminDb), 'alpha', 10);
      const prioSnap = await get(ref(clientDb));
      expect(prioSnap.val()).toBe('alpha');
      expect(prioSnap.priority).toBe(10);

      for (const scalar of ['beta', 42, false] as const) {
        await set(ref(adminDb), scalar);
        expect((await get(ref(clientDb))).val()).toBe(scalar);

        const observed: unknown[] = [];
        const unsub = onValue(ref(clientDb), (snap) => observed.push(snap.val()));
        expect(observed).toEqual([scalar]);
        unsub();

        await setPriority(ref(clientDb), 5);
        expect((await get(ref(clientDb))).priority).toBe(5);
        await setPriority(ref(clientDb), null);
        expect((await get(ref(clientDb))).priority).toBeNull();
      }

      await set(ref(adminDb), 10);
      const txResult = await runTransaction(ref(clientDb), (current) => (typeof current === 'number' ? current + 5 : 0));
      expect(txResult.committed).toBe(true);
      expect(txResult.snapshot.val()).toBe(15);

      await update(ref(clientDb), { 'items/i1': 'gamma' });
      expect((await get(ref(clientDb))).val()).toEqual({ items: { i1: 'gamma' } });

      await set(ref(adminDb), 'to-remove');
      await remove(ref(clientDb));
      expect((await get(ref(clientDb))).val()).toBeNull();
    } finally {
      sb.dispose();
    }
  });

  it('replays rtdb-modular-leaf-promotion-priority and rtdb-modular-set-replaces-not-merges at root ref(db) (M73)', async () => {
    const promoObs = load('rtdb-modular-leaf-promotion-priority.json');
    const replaceObs = load('rtdb-modular-set-replaces-not-merges.json');
    const directSetExpected = promoObs.directSetPromotion as {
      beforeServerExport: unknown;
      afterWriterClientPriority: unknown;
      afterWriterClientExport: unknown;
      afterFreshClientPriority: unknown;
      afterFreshClientExport: unknown;
    };
    const directUpdateExpected = promoObs.directUpdatePromotion as {
      beforeServerExport: unknown;
      afterWriterClientPriority: unknown;
      afterWriterClientExport: unknown;
      afterFreshClientPriority: unknown;
      afterFreshClientExport: unknown;
    };

    const sb = initializeSandbox();
    try {
      const writerDb = getDatabase(sb.withAuth({ uid: 'root-writer' }));
      const readerDb = getDatabase(sb.withAuth({ uid: 'root-reader' }));
      rtdbSandbox.setDefaultPolicy(writerDb, 'allow');

      await setWithPriority(ref(writerDb), 'leaf-val', 42);
      expect((await get(ref(readerDb))).exportVal()).toEqual(directSetExpected.beforeServerExport);
      await set(ref(writerDb, 'child'), 'v1');
      const writerAfterSet = await get(ref(writerDb));
      const readerAfterSet = await get(ref(readerDb));
      expect(writerAfterSet.priority).toBe(directSetExpected.afterWriterClientPriority as number);
      expect(writerAfterSet.exportVal()).toEqual(directSetExpected.afterWriterClientExport);
      expect(readerAfterSet.priority).toBe(directSetExpected.afterFreshClientPriority as number);
      expect(readerAfterSet.exportVal()).toEqual(directSetExpected.afterFreshClientExport);

      await setWithPriority(ref(writerDb), 99, 'prio-alpha');
      expect((await get(ref(readerDb))).exportVal()).toEqual(directUpdateExpected.beforeServerExport);
      await update(ref(writerDb), { child: 'v2' });
      const writerAfterUpdate = await get(ref(writerDb));
      const readerAfterUpdate = await get(ref(readerDb));
      expect(writerAfterUpdate.priority).toBe(directUpdateExpected.afterWriterClientPriority as string);
      expect(writerAfterUpdate.exportVal()).toEqual(directUpdateExpected.afterWriterClientExport);
      expect(readerAfterUpdate.priority).toBe(directUpdateExpected.afterFreshClientPriority as string);
      expect(readerAfterUpdate.exportVal()).toEqual(directUpdateExpected.afterFreshClientExport);

      await set(ref(writerDb), { a: 1, b: 2 });
      await set(ref(writerDb), { a: 1 });
      const replacedRoot = (await get(ref(writerDb))).val() as Record<string, unknown>;
      expect(replacedRoot).toEqual(replaceObs.final as Record<string, unknown>);
      expect(Object.keys(replacedRoot)).toEqual(replaceObs.finalKeys as string[]);
      expect('b' in replacedRoot).toBe(!(replaceObs.bIsAbsent as boolean));
    } finally {
      sb.dispose();
    }
  });
});
