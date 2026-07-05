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
});
