/**
 * FS-B14 — modular `onSnapshot` observer discriminator.
 *
 * `onSnapshot(ref, { error: fn })` — an observer carrying only `error`
 * (no `next`) — was misrouted as a `SnapshotListenOptions` object by the
 * old `!('next' in arg2)` test, so it was dropped and the call surfaced
 * "missing next handler". The fix uses `isPartialObserver` semantics (an
 * object with any of `next`/`error`/`complete` as a function is an
 * observer), mirroring `clones/.../api/observer.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getFirestore,
  doc,
  onSnapshot,
  sandbox as sandboxOps,
} from '../../src/firestore/index.js';

const DENY_READ = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /secret/{id} { allow read: if false; allow write: if true; }
    match /open/{id} { allow read, write: if true; }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'u' }));
  sandboxOps.setRules(db, DENY_READ);
  sandboxOps.seedDocuments(db, { 'open/o1': { v: 1 } });
  return db;
}

describe('FS-B14 — { error: fn } observer is routed, not dropped', () => {
  it('an error-only observer does not throw "missing next handler" and receives the denial', async () => {
    const db = setup();
    let errored: unknown;
    let unsub: (() => void) | undefined;
    // Pre-fix: this call threw synchronously ("missing next handler") because
    // the { error } observer was treated as options.
    expect(() => {
      unsub = onSnapshot(doc(db, 'secret/s1'), {
        error: (e: unknown) => { errored = e; },
      });
    }).not.toThrow();
    // The denied listen routes to the error observer.
    await new Promise((r) => setTimeout(r, 10));
    expect(errored).toBeDefined();
    unsub?.();
  });

  it('a { next: fn } observer still works (regression guard)', async () => {
    const db = setup();
    let got: unknown;
    const unsub = onSnapshot(doc(db, 'open/o1'), {
      next: (snap: { data(): unknown }) => { got = snap.data(); },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual({ v: 1 });
    unsub();
  });
});
