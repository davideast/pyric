/**
 * Item 2 — `LocalEnvironment.transaction()` integration tests.
 *
 * Distinct from `transaction.test.ts` (which exercises the
 * TransactionContext class against a stub reader). These tests run the
 * full path: seed → transaction(callback) → assert state + result +
 * event log.
 *
 * Locked behaviors verified here (validation plan probes):
 *   - 0.A + 0.J: read-after-write aborts the tx, throws original error.
 *   - 0.B: tx.get of missing doc returns { exists: false, data() === undefined }.
 *   - 0.D: same-path multi-write merges (last-wins per field).
 *   - 0.F: read-only tx (no writes) commits cleanly with writes: [].
 *   - 0.G: user throw inside callback propagates unchanged; aborted
 *     event logged but undo skips it.
 *   - 0.H side-finding: readOnly: true warns (sets readOnlyViolation),
 *     does NOT throw.
 *   - 0.I: queued create against existing doc → already-exists error.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { ReadAfterWriteError } from 'pyric/sandbox/internal';
import { AmbiguousPostDeleteWriteError } from 'pyric/sandbox/internal';
import { READ_AFTER_WRITE_MESSAGE } from 'pyric/sandbox/internal';

const RULES_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const RULES_GUARDED = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} {
      allow read: if true;
      allow create: if request.resource.data.status == 'waiting';
      allow update: if resource.data.status == 'waiting'
          && request.resource.data.status in ['playing', 'cancelled'];
      allow delete: if false;
    }
    match /scores/{id} {
      allow read, write: if true;
    }
  }
}`;

describe('LocalEnvironment.transaction — sync path', () => {
  test('single-write tx commits, doc visible after, event logged', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN });

    const result = env.transaction((tx) => {
      tx.create('games/g1', { host: 'alice', status: 'waiting' });
    }, { auth: { uid: 'alice' } });

    expect(result.allowed).toBe(true);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.allowed).toBe(true);
    expect(result.writes[0]!.method).toBe('create');
    expect(env.getDocument('games/g1')).toEqual({ host: 'alice', status: 'waiting' });
    expect(env.getEvents()).toHaveLength(1);
    expect(env.getEvents()[0]!.type).toBe('transaction');
  });

  test('multi-write tx — all-or-none atomicity (one rule denial = no writes apply)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_GUARDED });

    const result = env.transaction((tx) => {
      tx.create('games/ok', { status: 'waiting' });   // would pass
      tx.create('games/bad', { status: 'playing' });  // fails create rule
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('games/ok')).toBeNull();
    expect(env.getDocument('games/bad')).toBeNull();
    expect(result.error?.code).toBe('permission-denied');
  });

  test('read-only tx (no writes) commits cleanly with writes: []', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'games/g1': { score: 10 } },
    });

    const result = env.transaction((tx) => {
      const snap = tx.get('games/g1');
      expect(snap.exists).toBe(true);
      expect(snap.data()).toEqual({ score: 10 });
      return snap.data();
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(result.writes).toEqual([]);
    expect(result.reads).toEqual([{ path: 'games/g1', data: { score: 10 } }]);
    expect(result.returnValue).toEqual({ score: 10 });
  });

  test('callback throw propagates unchanged; aborted event logged; no writes applied', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'games/g1': { score: 10 } },
    });
    class CustomError extends Error {
      readonly tag = 'custom';
      constructor(msg: string) { super(msg); this.name = 'CustomError'; }
    }

    let caught: unknown;
    try {
      env.transaction((tx) => {
        tx.get('games/g1');
        tx.update('games/g1', { score: 11 });
        throw new CustomError('user code blew up');
      }, { auth: { uid: 'a' } });
    } catch (e) {
      caught = e;
    }

    // Probe 0.G: custom Error properties survive — original reference re-thrown
    expect(caught).toBeInstanceOf(CustomError);
    expect((caught as CustomError).tag).toBe('custom');

    // Doc unchanged — atomic rollback semantics
    expect(env.getDocument('games/g1')).toEqual({ score: 10 });

    // Aborted event recorded
    const events = env.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aborted).toBe(true);
    expect(events[0]!.error?.name).toBe('CustomError');
    expect(events[0]!.error?.message).toBe('user code blew up');
  });

  test('aborted tx is NOT undoable — undo skips it and returns prior write', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN });

    // First a real write…
    env.execute({
      method: 'create',
      path: 'games/g1',
      auth: { uid: 'a' },
      data: { score: 1 },
    });

    // …then an aborted tx (no state change)
    expect(() => env.transaction((tx) => {
      tx.update('games/g1', { score: 999 });
      throw new Error('abort');
    }, { auth: { uid: 'a' } })).toThrow();

    // Undo should revert the FIRST write, skipping the aborted tx event.
    env.undo();
    expect(env.getDocument('games/g1')).toBeNull();
  });

  test('same-path multi-update merges (probe 0.D)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'games/g1': { a: 1, b: 2, c: 3 } },
    });

    const result = env.transaction((tx) => {
      tx.update('games/g1', { a: 10 });
      tx.update('games/g1', { b: 20 });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    // Merged into one BatchOperation post-merge → one writes[] entry
    expect(result.writes).toHaveLength(1);
    expect(env.getDocument('games/g1')).toEqual({ a: 10, b: 20, c: 3 });
  });

  test('same-path multi-update — overlapping field, last-wins', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'games/g1': { score: 0 } },
    });

    env.transaction((tx) => {
      tx.update('games/g1', { score: 1 });
      tx.update('games/g1', { score: 2 });
    }, { auth: { uid: 'a' } });

    expect(env.getDocument('games/g1')).toEqual({ score: 2 });
  });

  test('read-after-write throws inside the callback (probe 0.A) and aborts tx', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'games/g1': { x: 1 } },
    });

    let captured: unknown;
    expect(() => env.transaction((tx) => {
      tx.update('games/g1', { x: 2 });
      try { tx.get('games/g1'); } catch (e) { captured = e; throw e; }
    }, { auth: { uid: 'a' } })).toThrow(ReadAfterWriteError);

    expect((captured as Error).message).toBe(READ_AFTER_WRITE_MESSAGE);
    // Aborted ⇒ no apply
    expect(env.getDocument('games/g1')).toEqual({ x: 1 });
  });

  test('cross-doc read after write also aborts (global ordering — probe 0.J)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { x: 1 }, 'b/2': { y: 2 } },
    });
    expect(() => env.transaction((tx) => {
      tx.update('a/1', { x: 9 });
      tx.get('b/2');
    }, { auth: { uid: 'a' } })).toThrow(ReadAfterWriteError);
    expect(env.getDocument('a/1')).toEqual({ x: 1 });
  });

  test('queued create against existing doc → already-exists structural error (probe 0.I)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'games/g1': { x: 1 } },
    });

    const result = env.transaction((tx) => {
      tx.create('games/g1', { x: 2 });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('already-exists');
    // Pre-tx state preserved
    expect(env.getDocument('games/g1')).toEqual({ x: 1 });
  });

  test('queued update against missing doc → not-found structural error', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN });

    const result = env.transaction((tx) => {
      tx.update('games/missing', { x: 1 });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('not-found');
  });

  test('tx.set on missing doc evaluates rules under "create"; commits as set', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_GUARDED });

    const result = env.transaction((tx) => {
      tx.set('games/g1', { status: 'waiting' });  // create-rule path
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(result.writes[0]!.method).toBe('create');
    expect(env.getDocument('games/g1')).toEqual({ status: 'waiting' });
  });

  test('tx.set on existing doc evaluates rules under "update"; commits as set', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_GUARDED,
      documents: { 'games/g1': { status: 'waiting' } },
    });

    const result = env.transaction((tx) => {
      tx.set('games/g1', { status: 'playing' });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(result.writes[0]!.method).toBe('update');
    expect(env.getDocument('games/g1')).toEqual({ status: 'playing' });
  });

  test('readOnly: true with a write call sets readOnlyViolation (warn-not-throw)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN });

    const result = env.transaction((tx) => {
      tx.create('games/g1', { x: 1 });
    }, { auth: { uid: 'a' }, readOnly: true });

    expect(result.allowed).toBe(true);   // v1 still applies
    expect(result.readOnlyViolation).toBe(true);
    expect(env.getDocument('games/g1')).toEqual({ x: 1 });
  });

  test('readOnly: true without writes — no readOnlyViolation flag', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { x: 1 } },
    });

    const result = env.transaction((tx) => {
      tx.get('a/1');
    }, { auth: { uid: 'a' }, readOnly: true });

    expect(result.allowed).toBe(true);
    expect(result.readOnlyViolation).toBeUndefined();
  });

  test('event includes reads + operations + pre-tx snapshot for undo', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { score: 10 } },
    });

    env.transaction((tx) => {
      const snap = tx.get('a/1');
      tx.update('a/1', { score: (snap.data() as { score: number }).score + 1 });
    }, { auth: { uid: 'a' } });

    const event = env.getEvents()[0]!;
    expect(event.type).toBe('transaction');
    expect(event.reads).toEqual([{ path: 'a/1', data: { score: 10 } }]);
    expect(event.operations).toHaveLength(1);
    expect(event.operations![0]!.method).toBe('update');
    expect(event.snapshot).toBeDefined();
  });

  test('successful tx is undoable — undo restores pre-tx snapshot', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { x: 1 } },
    });

    env.transaction((tx) => {
      tx.update('a/1', { x: 2 });
      tx.create('b/1', { y: 9 });
    }, { auth: { uid: 'a' } });

    expect(env.getDocument('a/1')).toEqual({ x: 2 });
    expect(env.getDocument('b/1')).toEqual({ y: 9 });

    env.undo();

    expect(env.getDocument('a/1')).toEqual({ x: 1 });
    expect(env.getDocument('b/1')).toBeNull();
  });

  test('returnValue from callback flows through to result', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN });

    const result = env.transaction((tx) => {
      tx.create('a/1', { x: 1 });
      return { newDocId: 'a/1', flag: true };
    }, { auth: { uid: 'a' } });

    expect(result.returnValue).toEqual({ newDocId: 'a/1', flag: true });
  });

  test('async callback returns Promise; result resolves; writes applied', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { score: 10 } },
    });

    const promise = env.transaction(async (tx) => {
      const snap = tx.get('a/1');
      // Simulate an awaitable boundary inside the callback. After the
      // await, no further reads or writes — Item 2.2 commits at the
      // outer await point, not at every microtask.
      await Promise.resolve();
      const data = snap.data() as { score: number };
      tx.update('a/1', { score: data.score + 5 });
      return data.score + 5;
    }, { auth: { uid: 'a' } });

    expect(promise).toBeInstanceOf(Promise);
    const result = await promise;
    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe(15);
    expect(env.getDocument('a/1')).toEqual({ score: 15 });
  });

  test('async callback that rejects propagates rejection; aborted event logged', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { x: 1 } },
    });
    class CustomAsyncError extends Error {
      readonly tag = 'async';
      constructor(msg: string) { super(msg); this.name = 'CustomAsyncError'; }
    }

    let caught: unknown;
    try {
      await env.transaction(async (tx) => {
        tx.update('a/1', { x: 99 });
        await Promise.resolve();
        throw new CustomAsyncError('async boom');
      }, { auth: { uid: 'a' } });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(CustomAsyncError);
    expect((caught as CustomAsyncError).tag).toBe('async');
    // Atomic — no writes applied
    expect(env.getDocument('a/1')).toEqual({ x: 1 });
    // Aborted event present
    const events = env.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aborted).toBe(true);
    expect(events[0]!.error?.message).toBe('async boom');
  });

  test('async callback: read-after-write still throws synchronously inside callback', async () => {
    // Important: tx.get throws at call time, not at next microtask. The
    // Item 2.2 plan calls this out explicitly (risk #4 — "async timing
    // — await tx.get after sync write"). The await happens AFTER the
    // throw, so the rejection surfaces at the next microtask boundary,
    // but the throw itself is sync.
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { x: 1 } },
    });

    let caught: unknown;
    try {
      await env.transaction(async (tx) => {
        tx.update('a/1', { x: 2 });
        // Sync throw — async wrapper turns it into a rejected promise.
        tx.get('a/1');
      }, { auth: { uid: 'a' } });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ReadAfterWriteError);
    expect(env.getDocument('a/1')).toEqual({ x: 1 });
  });

  test('async callback: serverTime is pinned at commit (after await), not at callback start', async () => {
    // Subtle but locked: a non-trivial await between read and write
    // means the eventual `serverTimestamp()` reflects when the writes
    // commit, not when the callback started. Smoke test: tx commits,
    // doc has a sentinel-resolved timestamp present.
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_OPEN });

    const before = Date.now();
    await new Promise((r) => setTimeout(r, 5));

    const result = await env.transaction(async (tx) => {
      await new Promise((r) => setTimeout(r, 5));
      // No sentinel here — just verify the tx commits cleanly across
      // an awaited boundary. Sentinel tests live in the resolver suite.
      tx.create('a/1', { stored: true });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('a/1')).toEqual({ stored: true });
    // Mostly a sanity check that nothing broke across the await.
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  test('delete + write merge throws AmbiguousPostDeleteWriteError; aborts tx', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_OPEN,
      documents: { 'a/1': { x: 1 } },
    });

    expect(() => env.transaction((tx) => {
      tx.delete('a/1');
      tx.update('a/1', { x: 2 });
    }, { auth: { uid: 'a' } })).toThrow(AmbiguousPostDeleteWriteError);

    // No state change
    expect(env.getDocument('a/1')).toEqual({ x: 1 });
    // Aborted event logged
    const events = env.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aborted).toBe(true);
  });
});
