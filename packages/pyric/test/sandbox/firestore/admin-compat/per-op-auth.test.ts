/**
 * Per-op auth override (divergence #6, issue #199).
 *
 * Each surface accepts an optional trailing `OperationOptions` arg
 * carrying `{ auth }`. When provided, the override replaces the
 * constructor-default for that single call. Same agent code can issue
 * ops on behalf of different users without re-constructing the
 * Firestore handle.
 *
 * Coverage: every surface listed in #199 — DocumentReference.{get, set,
 * update, delete}, CollectionReference.add, Query.get, WriteBatch.commit,
 * Firestore.runTransaction. Each test pairs a permissive default with a
 * restrictive rule (or vice-versa) so the override actually changes the
 * decision — assertions on default-vs-override outcomes prove the
 * threading is real, not just plumbed.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FirestoreCompatError,
} from '../../../../src/firestore/sandbox/admin-compat/index.js';

// Owner-gated rules: doc.ownerId must match request.auth.uid.
const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /accounts/{id} {
      allow read, write: if request.auth != null
        && request.auth.uid == resource.data.ownerId;
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.ownerId;
    }
    match /open/{id} { allow read, write: if true; }
  }
}`;

function freshDb() {
  const env = new LocalEnvironment();
  env.seed({
    rules: OWNER_RULES,
    documents: {
      'accounts/a': { ownerId: 'alice', balance: 100 },
      'accounts/b': { ownerId: 'bob',   balance: 200 },
    },
  });
  // Constructor default: alice.
  const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
  return { env, db };
}

describe('per-op auth — DocumentReference', () => {
  test('get: default auth fails on bob doc; override succeeds', async () => {
    const { db } = freshDb();
    // Default (alice) cannot read bob's doc.
    let denied: unknown;
    try { await db.doc('accounts/b').get(); } catch (e) { denied = e; }
    expect(denied).toBeInstanceOf(FirestoreCompatError);
    expect((denied as FirestoreCompatError).code).toBe('permission-denied');
    // Override to bob — succeeds.
    const snap = await db.doc('accounts/b').get({ auth: { uid: 'bob' } });
    expect(snap.exists).toBe(true);
    expect(snap.data()!.balance).toBe(200);
  });

  test('set: override auth applies the write under that uid', async () => {
    const { env, db } = freshDb();
    // Override to bob — bob owns accounts/b, so update succeeds.
    await db.doc('accounts/b').set(
      { ownerId: 'bob', balance: 250 },
      { auth: { uid: 'bob' } },
    );
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(250);
  });

  test('update: default auth fails on bob doc; override succeeds', async () => {
    const { env, db } = freshDb();
    let denied: unknown;
    try { await db.doc('accounts/b').update({ balance: 999 }); } catch (e) { denied = e; }
    expect(denied).toBeInstanceOf(FirestoreCompatError);
    await db.doc('accounts/b').update({ balance: 999 }, { auth: { uid: 'bob' } });
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(999);
  });

  test('delete: override auth applies the delete under that uid', async () => {
    const { env, db } = freshDb();
    await db.doc('accounts/b').delete({ auth: { uid: 'bob' } });
    expect(env.getDocument('accounts/b')).toBeNull();
  });

  test('omitting opts falls back to constructor-default auth', async () => {
    const { db } = freshDb();
    // No opts → alice (default) → can read accounts/a.
    const snap = await db.doc('accounts/a').get();
    expect(snap.data()!.balance).toBe(100);
  });
});

describe('per-op auth — CollectionReference.add', () => {
  test('add under override auth uses that uid for the create rule', async () => {
    const { env, db } = freshDb();
    // Owner-gated create: ownerId must match request.auth.uid. Bob can
    // only add a doc whose ownerId is 'bob'.
    const ref = await db.collection('accounts').add(
      { ownerId: 'bob', balance: 50 },
      { auth: { uid: 'bob' } },
    );
    expect((env.getDocument(ref.path) as { ownerId: string }).ownerId).toBe('bob');
  });
});

describe('per-op auth — WriteBatch.commit', () => {
  test('batch.commit({auth}) applies all ops under the override uid', async () => {
    const { env, db } = freshDb();
    const b = db.batch();
    b.update(db.doc('accounts/b'), { balance: 300 });
    // Default would deny (alice can't write to bob's doc); override
    // makes the whole batch run as bob.
    await b.commit({ auth: { uid: 'bob' } });
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(300);
  });

  test('batch.commit() with no opts falls back to constructor-default auth', async () => {
    const { env, db } = freshDb();
    const b = db.batch();
    b.update(db.doc('accounts/a'), { balance: 150 });
    await b.commit();
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(150);
  });
});

describe('per-op auth — Firestore.runTransaction', () => {
  test('runTransaction(fn, {auth}) runs the whole tx under the override uid', async () => {
    const { env, db } = freshDb();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.doc('accounts/b'));
      tx.update(db.doc('accounts/b'), {
        balance: (snap.data()!.balance as number) + 100,
      });
    }, { auth: { uid: 'bob' } });
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(300);
  });

  test('runTransaction with no opts falls back to constructor-default auth', async () => {
    const { env, db } = freshDb();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.doc('accounts/a'));
      tx.update(db.doc('accounts/a'), {
        balance: (snap.data()!.balance as number) - 25,
      });
    });
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(75);
  });
});

describe('per-op auth — Query.get enforces rules (FS-B1)', () => {
  test('Query.get on owner-gated rules denies the unconstrained list', async () => {
    // FS-B1: query reads evaluate security rules — they no longer go
    // through the raw, rules-bypassing env.listDocuments. The accounts
    // collection's read rule gates on `resource.data.ownerId`, which an
    // unconstrained `list` can't prove ("rules are not filters"), so the
    // query is denied — same as production. Pre-FS-B1 this returned both
    // docs regardless of auth (the bypass this test used to pin).
    const { db } = freshDb();
    let aliceDenied: unknown;
    try { await db.collection('accounts').get(); } catch (e) { aliceDenied = e; }
    expect(aliceDenied).toBeInstanceOf(FirestoreCompatError);
    expect((aliceDenied as FirestoreCompatError).code).toBe('permission-denied');
    // The override auth still has to clear the same rule — denied too.
    let bobDenied: unknown;
    try { await db.collection('accounts').get({ auth: { uid: 'bob' } }); } catch (e) { bobDenied = e; }
    expect(bobDenied).toBeInstanceOf(FirestoreCompatError);
    expect((bobDenied as FirestoreCompatError).code).toBe('permission-denied');
  });

  test('Query.get on an allow-all collection returns every doc', async () => {
    // The `open` collection allows read unconditionally — the rule-
    // enforced read path returns the full set, proving enforcement
    // doesn't over-deny readable collections.
    const { env } = freshDb();
    env.adminSetDocument('open/x', { v: 1 });
    env.adminSetDocument('open/y', { v: 2 });
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    const snap = await db.collection('open').get();
    expect(snap.size).toBe(2);
  });
});

describe('per-op auth — null override flips to anonymous', () => {
  test('passing { auth: null } drops to anonymous and hits unauthenticated paths', async () => {
    const { db } = freshDb();
    let denied: unknown;
    try { await db.doc('accounts/a').get({ auth: null }); } catch (e) { denied = e; }
    expect(denied).toBeInstanceOf(FirestoreCompatError);
    expect((denied as FirestoreCompatError).code).toBe('permission-denied');
  });
});
