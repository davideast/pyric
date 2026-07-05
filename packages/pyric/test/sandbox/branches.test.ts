/**
 * Tests for the branches primitive exported from `@pyric/sandbox`.
 *
 * Branches compose on top of `snapshot()` + `replay()`: `fork(snapshot)`
 * seeds a fresh isolated sandbox from a `SandboxSnapshot`, `apply` re-
 * issues captured write events against it (the replay engine's per-write
 * logic, run incrementally), `diff` is a focused doc-level structural
 * diff (reusing the `Divergence` type), `promote` lands the branch's
 * mutations on a target, and `discard` drops it without touching the
 * target.
 *
 * Imports come from the main sandbox entry — branches is a first-class
 * export alongside `replay`.
 */
import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  fork,
  apply,
  diff,
  promote,
  discard,
  type Sandbox,
} from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /things/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

/** Stand up a live sandbox seeded with rules and some starting docs. */
function liveWith(docs: Record<string, Record<string, unknown>>): {
  sandbox: Sandbox;
  env: ReturnType<typeof getInternalEnv>;
} {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: RULES, documents: docs });
  return { sandbox, env };
}

/** Capture a fresh stream of write events produced by `fn` running on a
 *  throwaway sandbox seeded with `base`. Returns the event history. */
function captureEvents(
  base: Record<string, Record<string, unknown>>,
  fn: (env: ReturnType<typeof getInternalEnv>) => void,
) {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: RULES, documents: base });
  fn(env);
  return sandbox.history();
}

describe('branches — fork/apply/diff/promote/discard', () => {
  it('fork seeds an isolated sandbox from a snapshot (no leak to source)', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 } });

    const branch = fork(live.snapshot(), RULES);

    // Branch sees the seeded doc...
    expect(branch.sandbox.snapshot().firestore['things/a']).toEqual({ v: 1 });

    // ...and writing on the branch does NOT touch the live source.
    getInternalEnv(branch.sandbox).execute({
      method: 'update',
      path: 'things/a',
      auth: { uid: 'alice' },
      data: { v: 999 },
    });
    expect(branch.sandbox.snapshot().firestore['things/a']).toEqual({ v: 999 });
    expect(live.snapshot().firestore['things/a']).toEqual({ v: 1 });
  });

  it('CoW: a live write AFTER the fork does not leak into the branch', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 } });
    const branch = fork(live.snapshot(), RULES);

    // Mutate the LIVE sandbox after forking (update + a brand-new doc).
    getInternalEnv(live).execute({ method: 'update', path: 'things/a', auth: { uid: 'alice' }, data: { v: 1000 } });
    getInternalEnv(live).execute({ method: 'set', path: 'things/late', auth: { uid: 'alice' }, data: { v: 5 } });

    // The branch still sees the snapshot it forked from (CoW base is immutable).
    expect(branch.sandbox.snapshot().firestore['things/a']).toEqual({ v: 1 });
    expect(branch.sandbox.snapshot().firestore['things/late']).toBeUndefined();
  });

  it('CoW: a branch delete tombstones the base doc without touching the source', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 }, 'things/b': { v: 2 } });
    const branch = fork(live.snapshot(), RULES);

    getInternalEnv(branch.sandbox).execute({ method: 'delete', path: 'things/a', auth: { uid: 'alice' } });

    // Branch hides the deleted base doc but keeps the sibling...
    const branchDocs = branch.sandbox.snapshot().firestore;
    expect(branchDocs['things/a']).toBeUndefined();
    expect(branchDocs['things/b']).toEqual({ v: 2 });
    // ...and the live source still has it.
    expect(live.snapshot().firestore['things/a']).toEqual({ v: 1 });
  });

  it('CoW: mutating a nested value via a raw branch read does not corrupt live or siblings', () => {
    const { sandbox: live } = liveWith({ 'things/a': { tags: ['x', 'y'], meta: { n: 1 } } });
    const snap = live.snapshot();
    const b1 = fork(snap, RULES);
    const b2 = fork(snap, RULES);

    // Raw read off the branch snapshot, then mutate its nested objects in place.
    const read = b1.sandbox.snapshot().firestore['things/a'] as { tags: string[]; meta: { n: number } };
    read.tags.push('CORRUPT');
    read.meta.n = 999;

    // Base docs are deep-cloned per branch, so live, the sibling branch, and the
    // original snapshot are all untouched.
    expect(live.snapshot().firestore['things/a']).toEqual({ tags: ['x', 'y'], meta: { n: 1 } });
    expect(b2.sandbox.snapshot().firestore['things/a']).toEqual({ tags: ['x', 'y'], meta: { n: 1 } });
    expect(snap.firestore['things/a']).toEqual({ tags: ['x', 'y'], meta: { n: 1 } });
  });

  it('apply re-issues captured writes against the branch (over base docs)', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 } });
    const branch = fork(live.snapshot(), RULES);

    // Capture an update to the seeded doc + a brand-new doc.
    const events = captureEvents({ 'things/a': { v: 1 } }, (env) => {
      env.execute({ method: 'update', path: 'things/a', auth: { uid: 'alice' }, data: { v: 2 } });
      env.execute({ method: 'set', path: 'things/b', auth: { uid: 'alice' }, data: { v: 7 } });
    });

    apply(branch, events);

    const state = branch.sandbox.snapshot().firestore;
    expect(state['things/a']).toEqual({ v: 2 });
    expect(state['things/b']).toEqual({ v: 7 });
    // Source untouched.
    expect(live.snapshot().firestore['things/a']).toEqual({ v: 1 });
    expect(live.snapshot().firestore['things/b']).toBeUndefined();
  });

  it('diff surfaces added / changed / removed docs vs the live reference', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 }, 'things/gone': { v: 0 } });
    const branch = fork(live.snapshot(), RULES);

    const events = captureEvents(live.snapshot().firestore, (env) => {
      env.execute({ method: 'update', path: 'things/a', auth: { uid: 'alice' }, data: { v: 5 } });
      env.execute({ method: 'set', path: 'things/new', auth: { uid: 'alice' }, data: { v: 9 } });
      env.execute({ method: 'delete', path: 'things/gone', auth: { uid: 'alice' } });
    });
    apply(branch, events);

    const divergences = diff(branch, live);
    const byPath = new Map(divergences.map((d) => ['path' in d ? d.path : '', d]));

    // changed field on things/a
    const changed = divergences.find((d) => 'path' in d && d.path === 'things/a');
    expect(changed?.kind).toBe('real-divergence');

    // added doc things/new (live side undefined)
    const added = byPath.get('things/new');
    expect(added?.kind).toBe('real-divergence');
    expect(added && 'before' in added ? added.before : 'x').toBeUndefined();

    // removed doc things/gone (branch side undefined)
    const removed = byPath.get('things/gone');
    expect(removed?.kind).toBe('real-divergence');
    expect(removed && 'after' in removed ? removed.after : 'x').toBeUndefined();
  });

  it('diff is empty when the branch matches the live reference', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 } });
    const branch = fork(live.snapshot(), RULES);
    expect(diff(branch, live)).toHaveLength(0);
  });

  it('promote lands the branch mutations on the target; untouched docs survive', () => {
    const { sandbox: live } = liveWith({
      'things/a': { v: 1 },
      'things/keep': { v: 100 },
      'things/gone': { v: 0 },
    });
    const branch = fork(live.snapshot(), RULES);

    const events = captureEvents(live.snapshot().firestore, (env) => {
      env.execute({ method: 'update', path: 'things/a', auth: { uid: 'alice' }, data: { v: 42 } });
      env.execute({ method: 'set', path: 'things/new', auth: { uid: 'alice' }, data: { v: 9 } });
      env.execute({ method: 'delete', path: 'things/gone', auth: { uid: 'alice' } });
    });
    apply(branch, events);

    promote(branch, live);

    const after = live.snapshot().firestore;
    expect(after['things/a']).toEqual({ v: 42 }); // changed → landed
    expect(after['things/new']).toEqual({ v: 9 }); // added → landed
    expect(after['things/gone']).toBeUndefined(); // deleted → removed
    expect(after['things/keep']).toEqual({ v: 100 }); // untouched → survived

    // A promoted branch is spent.
    expect(branch.discarded).toBe(true);
    expect(() => apply(branch, [])).toThrow();
  });

  it('discard leaves the target completely untouched', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 } });
    const before = live.snapshot().firestore;

    const branch = fork(live.snapshot(), RULES);
    const events = captureEvents(before, (env) => {
      env.execute({ method: 'set', path: 'things/b', auth: { uid: 'alice' }, data: { v: 2 } });
    });
    apply(branch, events);

    discard(branch);

    expect(live.snapshot().firestore).toEqual(before);
    expect(branch.discarded).toBe(true);
    // discard is idempotent.
    expect(() => discard(branch)).not.toThrow();
  });

  it('diff accepts a bare snapshot as the reference, not just a sandbox', () => {
    const { sandbox: live } = liveWith({ 'things/a': { v: 1 } });
    const baseline = live.snapshot();
    const branch = fork(baseline, RULES);

    apply(
      branch,
      captureEvents(baseline.firestore, (env) => {
        env.execute({ method: 'update', path: 'things/a', auth: { uid: 'alice' }, data: { v: 2 } });
      }),
    );

    const divergences = diff(branch, baseline);
    expect(divergences.some((d) => 'path' in d && d.path === 'things/a')).toBe(true);
  });
});
