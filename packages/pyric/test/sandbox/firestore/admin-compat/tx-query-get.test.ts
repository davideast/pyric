/**
 * Slice 5 — `TransactionImpl.get` accepts both `DocumentReference`
 * (existing path) and `Query` (the new overload added by bench's PR #7).
 *
 * Ports `pilot/tests/probe-tx-query-get.ts`. Backstory: the v1 e2b sweep
 * surfaced this gap on `parameterized_balance_update/tools` — the agent
 * kept reaching for `tx.get(collectionRef)` and got `TypeError` every
 * iteration. Test #4 below is the regression for that exact failure
 * pattern; the others cover the surrounding contract.
 *
 * Divergence from the bench probe: the read-after-write check asserts
 * the typed `FirestoreCompatError { code: 'failed-precondition' }`
 * surface (divergence #4-A) instead of bench's `err.message.includes('read')`
 * substring check.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FirestoreCompatError,
} from '../../../../src/sandbox/firestore/admin-compat/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function fresh() {
  const env = new LocalEnvironment();
  env.seed({
    rules: RULES,
    documents: {
      'accounts/a': { balance: 1000, status: 'active', ownerId: 'alice' },
      'accounts/b': { balance: 500, status: 'inactive', ownerId: 'bob' },
      'accounts/c': { balance: 750, status: 'active', ownerId: 'carol' },
      'accounts/d': { balance: 200, status: 'suspended', ownerId: 'dave' },
    },
  });
  const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
  return { env, db };
}

describe('admin-compat — tx.get backwards compat (DocumentReference)', () => {
  test('tx.get(docRef) still returns a DocumentSnapshot', async () => {
    const { env, db } = fresh();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.doc('accounts/a'));
      tx.update(db.doc('accounts/a'), {
        balance: (snap.data()!.balance as number) - 100,
      });
    });
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(900);
  });
});

describe('admin-compat — tx.get(Query) overload', () => {
  test('tx.get(collection) returns QuerySnapshot with all docs', async () => {
    const { db } = fresh();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection('accounts'));
      expect(snap.size).toBe(4);
      expect(snap.docs.length).toBe(4);
      expect(snap.docs.find((d) => d.id === 'a')!.data().balance).toBe(1000);
      expect(snap.docs.find((d) => d.id === 'c')!.data().status).toBe('active');
    });
  });

  test('tx.get(query.where) filters wrapper-side', async () => {
    const { db } = fresh();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(
        db.collection('accounts').where('status', '==', 'active'),
      );
      expect(snap.size).toBe(2);
      expect(snap.docs.every((d) => d.data().status === 'active')).toBe(true);
    });
  });

  test('tx.get(query.orderBy.limit) returns top N by ordered field', async () => {
    const { db } = fresh();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(
        db.collection('accounts').orderBy('balance', 'desc').limit(2),
      );
      expect(snap.size).toBe(2);
      expect(snap.docs[0]!.data().balance).toBe(1000); // a
      expect(snap.docs[1]!.data().balance).toBe(750);  // c
    });
  });
});

describe('admin-compat — parameterized_balance_update regression (e2b sweep failure)', () => {
  // The original failure case: read collection, branch on status,
  // write atomically. Pre-PR-#7 this threw TypeError on tx.get(collection).
  test('full sweep applies writes only to active accounts', async () => {
    const { env, db } = fresh();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection('accounts'));
      for (const doc of snap.docs) {
        if (doc.data().status === 'active') {
          const newBalance = Math.floor((doc.data().balance as number) * 1.1);
          tx.update(doc.ref, { balance: newBalance });
        }
      }
    });
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(1100); // 1000 * 1.1
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(500);  // unchanged (inactive)
    expect((env.getDocument('accounts/c') as { balance: number }).balance).toBe(825);  // 750 * 1.1
    expect((env.getDocument('accounts/d') as { balance: number }).balance).toBe(200);  // unchanged (suspended)
  });
});

describe('admin-compat — read-set semantics preserved across query reads', () => {
  test('read-after-write inside tx (query path) → failed-precondition', async () => {
    // Catch at the runTransaction boundary: the wrapper translates
    // simulator-internal `ReadAfterWriteError` to typed
    // `FirestoreCompatError` in firestore.ts when the throw propagates
    // out of the callback. (User code catching inside the callback
    // would see the raw simulator error — that's a known seam.)
    const { db } = fresh();
    let caught: unknown;
    try {
      await db.runTransaction(async (tx) => {
        tx.update(db.doc('accounts/a'), { balance: 999 });
        await tx.get(db.collection('accounts'));
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FirestoreCompatError);
    expect((caught as FirestoreCompatError).code).toBe('failed-precondition');
  });
});

describe('admin-compat — empty query in tx', () => {
  test('empty query commits cleanly and leaves state unchanged', async () => {
    const { env, db } = fresh();
    // Drain the collection.
    await db.doc('accounts/a').delete();
    await db.doc('accounts/b').delete();
    await db.doc('accounts/c').delete();
    await db.doc('accounts/d').delete();

    let snapshotSize = -1;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection('accounts'));
      snapshotSize = snap.size;
    });
    expect(snapshotSize).toBe(0);
    expect(Object.keys(env.snapshot()).length).toBe(0);
  });
});
