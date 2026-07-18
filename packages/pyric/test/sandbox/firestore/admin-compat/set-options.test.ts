/**
 * `DocumentReference.set(data, options)` — `SetOptions` support.
 *
 * Pins:
 *   - default `set(data)` REPLACES the existing document (Firestore
 *     default; previously the wrapper merged via 'update' — that was a
 *     latent divergence from production).
 *   - `set(data, { merge: true })` deep-merges nested maps (FS-B6);
 *     fields not in `data` are preserved. (Nested deep-merge probes
 *     live in `field-path-merge.test.ts`; these top-level cases hold
 *     under deep merge too.)
 *   - `set(data, { mergeFields: [...] })` merges only the listed
 *     (dot-separated) field paths; other fields in `data` are ignored,
 *     other fields in the existing doc are preserved.
 *   - Missing-doc cases collapse to `create` for all three modes.
 *   - Rule eval still runs the `update` clause when the doc exists
 *     (no `allow set:` syntax in security rules) and `create` when
 *     absent — replace semantics affect STORAGE, not rule routing.
 *   - Per-op auth override threads through `options.auth`.
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
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

// Distinguishes the `create` rule clause from the `update` clause so a
// merge-on-missing-doc test can assert the right path runs.
const RULES_SPLIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read: if true;
      allow create: if request.auth != null && request.auth.uid == 'alice';
      allow update: if request.auth != null && request.auth.uid == 'bob';
    }
  }
}`;

function fresh() {
  const env = new LocalEnvironment();
  env.seed({
    rules: RULES_OPEN,
    documents: {
      'profile/alice': { name: 'Alice', age: 30, role: 'admin' },
    },
  });
  const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
  return { env, db };
}

describe('set() default — replace semantics', () => {
  test('overwrites existing doc, dropping fields not in data', async () => {
    const { env, db } = fresh();
    await db.doc('profile/alice').set({ name: 'Alice', age: 31 });
    expect(env.getDocument('profile/alice')).toEqual({ name: 'Alice', age: 31 });
  });

  test('creates doc when absent', async () => {
    const { env, db } = fresh();
    await db.doc('profile/bob').set({ name: 'Bob', age: 25 });
    expect(env.getDocument('profile/bob')).toEqual({ name: 'Bob', age: 25 });
  });

  test('passing no options preserves replace semantics on subsequent writes', async () => {
    const { env, db } = fresh();
    await db.doc('profile/alice').set({ name: 'Alice', age: 31 });
    await db.doc('profile/alice').set({ name: 'Alice' });
    // Second set drops `age` because it's not in the new data.
    expect(env.getDocument('profile/alice')).toEqual({ name: 'Alice' });
  });
});

describe('set(data, { merge: true })', () => {
  test('merges every top-level field, preserving the rest', async () => {
    const { env, db } = fresh();
    await db.doc('profile/alice').set({ age: 99 }, { merge: true });
    expect(env.getDocument('profile/alice')).toEqual({
      name: 'Alice',
      age: 99,
      role: 'admin',
    });
  });

  test('creates doc when absent (merge collapses to create)', async () => {
    const { env, db } = fresh();
    await db.doc('profile/charlie').set({ name: 'Charlie' }, { merge: true });
    expect(env.getDocument('profile/charlie')).toEqual({ name: 'Charlie' });
  });
});

describe('set(data, { mergeFields: [...] })', () => {
  test('merges only listed fields; ignores other keys in data', async () => {
    const { env, db } = fresh();
    await db.doc('profile/alice').set(
      { age: 42, role: 'superadmin', secret: 'ignored' },
      { mergeFields: ['age'] },
    );
    expect(env.getDocument('profile/alice')).toEqual({
      name: 'Alice',
      age: 42,
      role: 'admin', // unchanged — not in mergeFields
    });
  });

  test('multiple mergeFields project a subset of data', async () => {
    const { env, db } = fresh();
    await db.doc('profile/alice').set(
      { name: 'Alice (updated)', age: 31, role: 'superadmin', extra: 'no' },
      { mergeFields: ['name', 'age'] },
    );
    expect(env.getDocument('profile/alice')).toEqual({
      name: 'Alice (updated)',
      age: 31,
      role: 'admin',
    });
  });

  test('mergeField missing from data is silently skipped', async () => {
    const { env, db } = fresh();
    await db.doc('profile/alice').set(
      { age: 50 },
      { mergeFields: ['age', 'missing'] },
    );
    expect(env.getDocument('profile/alice')).toEqual({
      name: 'Alice',
      age: 50,
      role: 'admin',
    });
  });

  test('mergeFields on a missing doc creates with just those fields', async () => {
    const { env, db } = fresh();
    await db.doc('profile/zoe').set(
      { name: 'Zoe', age: 22, extra: 'no' },
      { mergeFields: ['name', 'age'] },
    );
    expect(env.getDocument('profile/zoe')).toEqual({ name: 'Zoe', age: 22 });
  });
});

describe('rule eval — set routes to create / update', () => {
  test('absent doc routes to `create` clause', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_SPLIT, documents: {} });
    const dbAlice = createCompatFirestore(env, { auth: { uid: 'alice' } });
    const dbBob = createCompatFirestore(env, { auth: { uid: 'bob' } });

    // Bob is allowed to update but NOT create — should be denied here.
    let bobDenied: unknown;
    try { await dbBob.doc('docs/d1').set({ v: 1 }); } catch (e) { bobDenied = e; }
    expect(bobDenied).toBeInstanceOf(FirestoreCompatError);
    expect((bobDenied as FirestoreCompatError).code).toBe('permission-denied');

    // Alice is allowed to create — should succeed.
    await dbAlice.doc('docs/d1').set({ v: 1 });
    expect(env.getDocument('docs/d1')).toEqual({ v: 1 });
  });

  test('existing doc routes to `update` clause', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_SPLIT,
      documents: { 'docs/d1': { v: 1 } },
    });
    const dbAlice = createCompatFirestore(env, { auth: { uid: 'alice' } });
    const dbBob = createCompatFirestore(env, { auth: { uid: 'bob' } });

    // Alice can create but NOT update — should be denied.
    let aliceDenied: unknown;
    try { await dbAlice.doc('docs/d1').set({ v: 2 }); } catch (e) { aliceDenied = e; }
    expect(aliceDenied).toBeInstanceOf(FirestoreCompatError);
    expect((aliceDenied as FirestoreCompatError).code).toBe('permission-denied');

    // Bob can update — should succeed AND replace.
    await dbBob.doc('docs/d1').set({ v: 2 });
    expect(env.getDocument('docs/d1')).toEqual({ v: 2 });
  });
});

describe('per-op auth override threads through SetOptions', () => {
  test('replace mode honors options.auth', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_SPLIT,
      documents: { 'docs/d1': { v: 1 } },
    });
    // Default = alice (would deny update). Override to bob (allowed).
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    await db.doc('docs/d1').set({ v: 99 }, { auth: { uid: 'bob' } });
    expect(env.getDocument('docs/d1')).toEqual({ v: 99 });
  });

  test('merge mode honors options.auth', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_SPLIT,
      documents: { 'docs/d1': { v: 1, keep: 'me' } },
    });
    const db = createCompatFirestore(env, { auth: { uid: 'alice' } });
    await db
      .doc('docs/d1')
      .set({ v: 99 }, { merge: true, auth: { uid: 'bob' } });
    expect(env.getDocument('docs/d1')).toEqual({ v: 99, keep: 'me' });
  });
});
