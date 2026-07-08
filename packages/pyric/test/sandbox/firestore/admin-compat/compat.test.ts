/**
 * Slice 5 — Admin-SDK-compat wrapper end-to-end exercise.
 *
 * Ports `pilot/tests/probe-wrapper.ts` Section 1 (the wrapper-side
 * assertions) from the bench harness into bun:test. Section 2 of the
 * bench probe exercises the VM round-trip via `runAgentCode`, which is
 * a bench-internal harness — not portable to the SDK side.
 *
 * Adds one extra assertion on top of the bench coverage: read-path
 * Timestamp shape translation (slice-4 marker — `(seconds, nanoseconds)`
 * with `instanceof Timestamp`, not the simulator's internal
 * `(seconds, nanos)` shape).
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FieldValue,
  FirestoreCompatError,
  Timestamp,
} from '../../../../src/sandbox/firestore/admin-compat/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function freshDb() {
  const env = new LocalEnvironment();
  env.seed({
    rules: RULES,
    documents: {
      'accounts/a': { balance: 1000, ownerId: 'alice' },
      'accounts/b': { balance: 250, ownerId: 'bob' },
    },
  });
  const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
  return { env, db };
}

describe('admin-compat — DocumentReference', () => {
  test('docRef.get() of an existing doc returns exists+data', async () => {
    const { db } = freshDb();
    const snap = await db.doc('accounts/a').get();
    expect(snap.exists).toBe(true);
    expect(snap.id).toBe('a');
    expect(snap.ref.path).toBe('accounts/a');
    expect(snap.data()).toEqual({ balance: 1000, ownerId: 'alice' });
  });

  test('docRef.get() of a missing doc returns exists=false / data=undefined', async () => {
    const { db } = freshDb();
    const snap = await db.doc('accounts/missing').get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  test('docRef.update() applies and is visible via env.getDocument', async () => {
    const { env, db } = freshDb();
    await db.doc('accounts/a').update({ balance: 900 });
    expect(env.getDocument('accounts/a')).toEqual({ balance: 900, ownerId: 'alice' });
  });

  test('docRef.delete() removes the doc', async () => {
    const { env, db } = freshDb();
    await db.doc('accounts/a').delete();
    expect(env.getDocument('accounts/a')).toBeNull();
  });

  test('docRef.parent returns CollectionReference with matching id+path', () => {
    const { db } = freshDb();
    const parent = db.doc('accounts/a').parent;
    expect(parent.path).toBe('accounts');
    expect(parent.id).toBe('accounts');
  });

  test('path validation: odd segments to db.doc() throws invalid-argument', () => {
    const { db } = freshDb();
    let caught: unknown;
    try { db.doc('accounts'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FirestoreCompatError);
    expect((caught as FirestoreCompatError).code).toBe('invalid-argument');
  });
});

describe('admin-compat — CollectionReference', () => {
  test('collRef.add() generates a 20-char id and writes the doc', async () => {
    const { env, db } = freshDb();
    const ref = await db.collection('logs').add({ event: 'test', at: 1 });
    expect(ref.id.length).toBe(20);
    expect(env.getDocument(ref.path)).toEqual({ event: 'test', at: 1 });
  });
});

describe('admin-compat — Query', () => {
  test('query.where(>=) filters', async () => {
    const { db } = freshDb();
    const snap = await db.collection('accounts').where('balance', '>=', 500).get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().ownerId).toBe('alice');
  });

  test('query.where(==) matches object values without depending on key order', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'profiles/a': { prefs: { role: 'admin', active: true } },
        'profiles/b': { prefs: { role: 'member', active: true } },
      },
    });
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });

    const snap = await db
      .collection('profiles')
      .where('prefs', '==', { active: true, role: 'admin' })
      .get();

    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.id).toBe('a');
  });

  test('query.orderBy(desc).limit(1)', async () => {
    const { db } = freshDb();
    const snap = await db.collection('accounts').orderBy('balance', 'desc').limit(1).get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().balance).toBe(1000);
  });
});

describe('admin-compat — WriteBatch', () => {
  test('batch.commit() applies all ops atomically', async () => {
    const { env, db } = freshDb();
    const b = db.batch();
    b.update(db.doc('accounts/a'), { balance: 900 });
    b.update(db.doc('accounts/b'), { balance: 350 });
    await b.commit();
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(900);
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(350);
  });
});

describe('admin-compat — runTransaction', () => {
  test('read-compute-write returns user value and applies all writes', async () => {
    const { env, db } = freshDb();
    const result = await db.runTransaction(async (tx) => {
      const snapA = await tx.get(db.doc('accounts/a'));
      const snapB = await tx.get(db.doc('accounts/b'));
      const balA = snapA.data()?.balance as number;
      const balB = snapB.data()?.balance as number;
      tx.update(db.doc('accounts/a'), { balance: balA - 100 });
      tx.update(db.doc('accounts/b'), { balance: balB + 100 });
      return { transferred: 100 };
    });
    expect(result).toEqual({ transferred: 100 });
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(900);
    expect((env.getDocument('accounts/b') as { balance: number }).balance).toBe(350);
  });
});

describe('admin-compat — FieldValue', () => {
  test('FieldValue.increment(-50) applies via update', async () => {
    const { env, db } = freshDb();
    await db.doc('accounts/a').update({ balance: FieldValue.increment(-50) });
    expect((env.getDocument('accounts/a') as { balance: number }).balance).toBe(950);
  });

  test('FieldValue.serverTimestamp() resolves on the simulator side', async () => {
    const { env, db } = freshDb();
    await db.doc('logs/x').set({ event: 'test', at: FieldValue.serverTimestamp() });
    const stored = env.getDocument('logs/x') as { at: { seconds: number; nanos: number } };
    // Internal storage shape — simulator's wrappers/timestamp.ts uses
    // (seconds, nanos). The compat shape translation happens on READ, not write.
    expect(typeof stored.at.seconds).toBe('number');
    expect(typeof stored.at.nanos).toBe('number');
  });
});

describe('admin-compat — read-path Timestamp translation (slice-4 marker)', () => {
  test('compat read returns Timestamp instance with (seconds, nanoseconds)', async () => {
    const { db } = freshDb();
    await db.doc('logs/y').set({ at: FieldValue.serverTimestamp() });
    const snap = await db.doc('logs/y').get();
    const at = snap.data()!.at as Timestamp;
    expect(at).toBeInstanceOf(Timestamp);
    expect(typeof at.seconds).toBe('number');
    expect(typeof at.nanoseconds).toBe('number');
    // Internal nanos field name should NOT leak through the read path.
    expect((at as unknown as { nanos?: unknown }).nanos).toBeUndefined();
  });

  test('translation walks into nested objects + arrays', async () => {
    const { db } = freshDb();
    await db.doc('logs/z').set({
      meta: { createdAt: FieldValue.serverTimestamp() },
      events: [{ at: FieldValue.serverTimestamp() }],
    });
    const snap = await db.doc('logs/z').get();
    const data = snap.data()!;
    const nested = (data.meta as { createdAt: Timestamp }).createdAt;
    const arrayItem = (data.events as Array<{ at: Timestamp }>)[0]!.at;
    expect(nested).toBeInstanceOf(Timestamp);
    expect(arrayItem).toBeInstanceOf(Timestamp);
  });
});
