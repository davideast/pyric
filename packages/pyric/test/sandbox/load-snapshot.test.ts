import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  serializeToBuckets,
  bundleRecords,
  parseBundle,
  deserializeFromBuckets,
} from '../../src/sandbox/index.js';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from '../../src/auth/index.js';

/**
 * Gate for `sandbox.loadSnapshot()` — the public clobber-restore that powers
 * transfer (Phase 2) and named-branch switching (Phase 3). It must be a TOTAL
 * replace, not an overlay.
 */
describe('sandbox.loadSnapshot (clobber-restore)', () => {
  it('round-trips: snapshot -> mutate -> loadSnapshot restores exactly', () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('todos/a', { title: 'first' });
    sandbox.admin.setDocument('todos/b', { title: 'second' });
    const snap = sandbox.snapshot();

    // Diverge: add, change, delete.
    sandbox.admin.setDocument('todos/c', { title: 'third' });
    sandbox.admin.setDocument('todos/a', { title: 'CHANGED' });
    sandbox.admin.deleteDocument('todos/b');

    sandbox.loadSnapshot(snap);

    expect(sandbox.admin.getDocument('todos/a')).toEqual({ title: 'first' });
    expect(sandbox.admin.getDocument('todos/b')).toEqual({ title: 'second' });
    expect(sandbox.admin.getDocument('todos/c') ?? null).toBeNull();
  });

  it('is a CLOBBER: docs absent from the snapshot do not survive', () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('keep/1', { v: 1 });
    const snap = sandbox.snapshot(); // only keep/1

    sandbox.admin.setDocument('extra/1', { v: 2 });
    sandbox.loadSnapshot(snap);

    expect(sandbox.admin.getDocument('keep/1')).toEqual({ v: 1 });
    expect(sandbox.admin.getDocument('extra/1') ?? null).toBeNull();
  });

  it('clears the signed-in session (reset semantics)', () => {
    const sandbox = initializeSandbox();
    const snap = sandbox.snapshot();
    sandbox.currentUser = { uid: 'alice' };
    sandbox.loadSnapshot(snap);
    expect(sandbox.currentUser).toBeNull();
  });

  it('a snapshot of an empty sandbox loads as empty', () => {
    const sandbox = initializeSandbox();
    const empty = sandbox.snapshot();
    sandbox.admin.setDocument('x/1', { a: 1 });
    sandbox.loadSnapshot(empty);
    expect(sandbox.admin.getDocument('x/1') ?? null).toBeNull();
  });

  it('round-trips through the serialized bundle (the worker export/import path)', () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('todos/a', { title: 'first', done: false });
    const snap = sandbox.snapshot();

    // export: snapshot -> bundle string (exactly what the worker exportState does)
    const bundle = bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0));

    sandbox.admin.setDocument('todos/b', { title: 'extra' }); // diverge

    // import: bundle -> loadSnapshot (exactly what the worker importState does)
    sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(bundle)));

    expect(sandbox.admin.getDocument('todos/a')).toEqual({ title: 'first', done: false });
    expect(sandbox.admin.getDocument('todos/b') ?? null).toBeNull();
  });

  it('restores auth users (the services path, not just firestore)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'kept@b.com', 'pw123456');
    const snap = sandbox.snapshot(); // services.auth carries kept@b.com

    // Diverge: a user that exists only AFTER the snapshot.
    await createUserWithEmailAndPassword(auth, 'gone@b.com', 'pw123456');

    sandbox.loadSnapshot(snap);

    // kept@b.com is back; gone@b.com was clobbered away.
    await expect(signInWithEmailAndPassword(auth, 'kept@b.com', 'pw123456')).resolves.toBeDefined();
    await expect(signInWithEmailAndPassword(auth, 'gone@b.com', 'pw123456')).rejects.toThrow();
  });

  it('deep-clones nested Firestore maps and arrays across snapshot() and loadSnapshot()', () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('items/i1', {
      meta: { count: 1, labels: { env: 'prod' } },
      tags: ['alpha', 'beta'],
    });

    const snap = sandbox.snapshot();
    (snap.firestore['items/i1']!.meta as { count: number }).count = 999;
    (snap.firestore['items/i1']!.tags as string[]).push('corrupted');

    expect(sandbox.admin.getDocument('items/i1')).toEqual({
      meta: { count: 1, labels: { env: 'prod' } },
      tags: ['alpha', 'beta'],
    });

    const cleanSnap = sandbox.snapshot();
    const target = initializeSandbox();
    target.loadSnapshot(cleanSnap);
    (cleanSnap.firestore['items/i1']!.meta as { count: number }).count = 555;
    expect(target.admin.getDocument('items/i1')).toEqual({
      meta: { count: 1, labels: { env: 'prod' } },
      tags: ['alpha', 'beta'],
    });
  });

  it('preserves deployed Firestore security rules across snapshot() and loadSnapshot()', async () => {
    const { doc, getDoc, getFirestore } = await import('../../src/firestore/index.js');
    const { getInternalEnv } = await import('../../src/sandbox/internal/sandbox-impl.js');

    const ownerOnlyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.ownerId;
    }
  }
}`;

    const sandbox = initializeSandbox();
    const initialRules = getInternalEnv(sandbox).getRules();
    const defaultSnap = sandbox.snapshot();

    getInternalEnv(sandbox).deployRules(ownerOnlyRules);
    sandbox.admin.setDocument('items/i1', { ownerId: 'u1', title: 'secret' });
    const securedSnap = sandbox.snapshot();

    sandbox.currentUser = { uid: 'u2' };
    const db = getFirestore(sandbox);
    await expect(getDoc(doc(db, 'items/i1'))).rejects.toThrow();

    sandbox.admin.setDocument('items/i2', { ownerId: 'u2', title: 'extra' });
    sandbox.loadSnapshot(securedSnap);

    sandbox.currentUser = { uid: 'u2' };
    await expect(getDoc(doc(db, 'items/i1'))).rejects.toThrow();
    sandbox.currentUser = { uid: 'u1' };
    expect((await getDoc(doc(db, 'items/i1'))).data()).toEqual({ ownerId: 'u1', title: 'secret' });

    sandbox.loadSnapshot(defaultSnap);
    expect(getInternalEnv(sandbox).getRules()).toBe(initialRules);
  });
});
