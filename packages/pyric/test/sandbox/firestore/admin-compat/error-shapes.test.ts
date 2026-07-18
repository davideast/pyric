/**
 * Slice 5 — Locked error-translation behaviors.
 *
 * Two divergences from the underlying simulator surface that the
 * admin-compat wrapper translates into typed `FirestoreCompatError`
 * codes the way Admin SDK consumers expect:
 *
 *   - Divergence #4-A: simulator throws `ReadAfterWriteError` (a plain
 *     Error subclass carrying `.simError`) when a tx reads after writing.
 *     Wrapper translates to `FirestoreCompatError { code:
 *     'failed-precondition' }` so callers can use the typed-code pattern
 *     without instanceof'ing an SDK-internal class.
 *
 *   - Divergence #4-B: simulator's `transaction()` returns
 *     `TransactionResult.allowed === false` (with a typed `error`) when
 *     a queued write fails at commit. Wrapper surfaces the typed error
 *     directly so the original error code (e.g., 'permission-denied')
 *     reaches the caller.
 *
 * Same translation lives in `WriteBatchImpl.commit` for the batch path.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FirestoreCompatError,
} from '../../../../src/firestore/sandbox/admin-compat/index.js';

const RULES_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const RULES_GUARDED = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /allowed/{x} { allow read, write: if true; }
    match /denied/{x}  { allow read: if true; allow write: if false; }
  }
}`;

describe('admin-compat — divergence #4-A (read-after-write)', () => {
  test('tx.set → tx.get(docRef) throws FirestoreCompatError(failed-precondition)', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN, documents: { 'docs/d1': { v: 1 } } });
    const db = createCompatFirestore(env, { auth: { uid: 'u1' } });

    let caught: unknown;
    try {
      await db.runTransaction(async (tx) => {
        tx.set(db.doc('docs/d2'), { v: 2 });
        await tx.get(db.doc('docs/d1'));
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FirestoreCompatError);
    expect((caught as FirestoreCompatError).code).toBe('failed-precondition');
  });

  test('tx.update → tx.get(query) throws FirestoreCompatError(failed-precondition)', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'items/a': { v: 1 }, 'items/b': { v: 2 } },
    });
    const db = createCompatFirestore(env, { auth: { uid: 'u1' } });

    let caught: unknown;
    try {
      await db.runTransaction(async (tx) => {
        tx.update(db.doc('items/a'), { v: 99 });
        await tx.get(db.collection('items'));
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FirestoreCompatError);
    expect((caught as FirestoreCompatError).code).toBe('failed-precondition');
  });
});

describe('admin-compat — divergence #4-B (typed error from result.allowed === false)', () => {
  test('tx with rule-denied write surfaces typed code', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_GUARDED, documents: {} });
    const db = createCompatFirestore(env, { auth: { uid: 'u1' } });

    let caught: unknown;
    try {
      await db.runTransaction(async (tx) => {
        tx.set(db.doc('denied/d1'), { v: 1 });
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FirestoreCompatError);
    expect((caught as FirestoreCompatError).code).toBe('permission-denied');
  });

  test('tx with mixed allowed/denied writes is atomic — neither applies', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_GUARDED, documents: {} });
    const db = createCompatFirestore(env, { auth: { uid: 'u1' } });

    await db.runTransaction(async (tx) => {
      tx.set(db.doc('allowed/a1'), { v: 1 });
      tx.set(db.doc('denied/d1'), { v: 2 });
    }).catch(() => { /* expected denial */ });

    expect(env.getDocument('allowed/a1')).toBeNull();
    expect(env.getDocument('denied/d1')).toBeNull();
  });
});

describe('admin-compat — batch denial mirrors tx denial shape', () => {
  test('batch with rule-denied write surfaces typed code', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_GUARDED, documents: {} });
    const db = createCompatFirestore(env, { auth: { uid: 'u1' } });

    const b = db.batch();
    b.set(db.doc('allowed/a1'), { v: 1 });
    b.set(db.doc('denied/d1'), { v: 2 });

    let caught: unknown;
    try { await b.commit(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FirestoreCompatError);
    expect((caught as FirestoreCompatError).code).toBe('permission-denied');
    // Atomicity — the allowed op must not have committed.
    expect(env.getDocument('allowed/a1')).toBeNull();
  });

  test('empty batch.commit() is a no-op', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN, documents: {} });
    const db = createCompatFirestore(env, { auth: { uid: 'u1' } });
    await db.batch().commit(); // should resolve cleanly
    expect(Object.keys(env.snapshot()).length).toBe(0);
  });
});
