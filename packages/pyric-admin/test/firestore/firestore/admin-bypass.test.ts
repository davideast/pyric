/**
 * `getAdminFirestore` — rules-bypassing admin lens (Pyric Studio Gap #2).
 *
 * The deny-vs-bypass contract: under a restrictive ruleset, the SAME write
 * is DENIED through `getFirestore(ctx)` (rules enforced) but SUCCEEDS through
 * `getAdminFirestore(...)` (rules skipped). The bypass still goes through the
 * store (the write actually lands) and still respects structural
 * preconditions (create-already-exists), matching real Firestore admin.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getFirestore, getAdminFirestore } from '../../../src/firestore/index.js';
import { getInternalEnv } from 'pyric/sandbox/internal';

// Deny everything — no read, no write, for anyone.
const DENY_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

function denyAllSandbox(): Sandbox {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).deployRules(DENY_ALL);
  return sandbox;
}

describe('getAdminFirestore shape + idempotency', () => {
  it('returns an Admin-shaped Firestore handle', () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    expect(typeof db.doc).toBe('function');
    expect(typeof db.collection).toBe('function');
    expect(typeof db.batch).toBe('function');
    expect(typeof db.runTransaction).toBe('function');
  });

  it('is idempotent per context', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth(null);
    expect(getAdminFirestore(ctx)).toBe(getAdminFirestore(ctx));
  });

  it('accepts a bare Sandbox (identity-agnostic)', () => {
    const sandbox = initializeSandbox();
    expect(typeof getAdminFirestore(sandbox).doc).toBe('function');
  });
});

describe('deny-vs-bypass: single-doc write', () => {
  it('rules DENY the write through getFirestore (regression guard)', async () => {
    const sandbox = denyAllSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await expect(db.doc('locked/x').set({ a: 1 })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // The write must NOT have landed.
    expect(sandbox.admin.getDocument('locked/x')).toBeNull();
  });

  it('admin handle BYPASSES rules — the same write succeeds and lands', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    await admin.doc('locked/x').set({ a: 1 });
    // Verify via the independent path-string admin plane.
    expect(sandbox.admin.getDocument('locked/x')).toEqual({ a: 1 });
  });
});

describe('deny-vs-bypass: read', () => {
  it('rules DENY the read through getFirestore', async () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('locked/x', { a: 1 });
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await expect(db.doc('locked/x').get()).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('admin handle reads despite deny-all rules', async () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('locked/x', { a: 1 });
    const admin = getAdminFirestore(sandbox);
    const snap = await admin.doc('locked/x').get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ a: 1 });
  });
});

describe('deny-vs-bypass: query read (getDocs / collection)', () => {
  it('admin handle lists a whole collection despite deny-all rules', async () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('items/a', { n: 1 });
    sandbox.admin.setDocument('items/b', { n: 2 });
    const admin = getAdminFirestore(sandbox);
    const snap = await admin.collection('items').get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['a', 'b']);
  });
});

describe('deny-vs-bypass: batch', () => {
  it('admin batch commits writes that rules would deny', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    const batch = admin.batch();
    batch.set(admin.doc('locked/a'), { v: 1 });
    batch.set(admin.doc('locked/b'), { v: 2 });
    await batch.commit();
    expect(sandbox.admin.getDocument('locked/a')).toEqual({ v: 1 });
    expect(sandbox.admin.getDocument('locked/b')).toEqual({ v: 2 });
  });
});

describe('deny-vs-bypass: transaction', () => {
  it('admin transaction commits writes that rules would deny', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    await admin.runTransaction(async (tx) => {
      tx.set(admin.doc('locked/t'), { v: 42 });
    });
    expect(sandbox.admin.getDocument('locked/t')).toEqual({ v: 42 });
  });
});

describe('admin still respects structural preconditions', () => {
  it('an update on a missing doc still fails not-found (precondition, not a rule check)', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    // The doc does not exist; bypassing rules does NOT bypass the
    // update-requires-existing precondition — matches real Firestore admin.
    await expect(admin.doc('missing/x').update({ a: 1 })).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(sandbox.admin.getDocument('missing/x')).toBeNull();
  });
});

describe('the rules-enforced handle is unchanged for allowed ops', () => {
  it('an open ruleset still allows a normal write through getFirestore', async () => {
    const sandbox = initializeSandbox(); // default open rules
    const db = getFirestore(sandbox.withAuth(null));
    await db.doc('open/x').set({ a: 1 });
    expect(sandbox.admin.getDocument('open/x')).toEqual({ a: 1 });
  });
});
