/**
 * Item 5.2 — Conditional state-machine fixture.
 *
 * Read a doc, branch on its `status` field, write the right transition.
 * This fixture is the canary for the **probe 0.E extrapolation**:
 *
 *   "Per-write rules evaluation against pre-tx state — no inter-write
 *    visibility (extrapolated from batch parity, 0.E)."
 *
 * If the extrapolation is wrong (i.e., production rules see queued
 * writes via `request.resource.data` overlay), this fixture's rules
 * would deny a transaction the simulator allows. The asymmetry would
 * show up as a passing local test that fails in prod — exactly the
 * misleading-DENY pattern this whole project exists to prevent.
 *
 * Rules here exercise distinct branches:
 *   pending → active : allowed
 *   pending → done   : denied (must transit through active)
 *   active  → done   : allowed
 *   done    → *      : denied (terminal)
 *
 * Each transition is a single-write tx; the state-machine shape
 * implies the test asserts on what the rule saw given the pre-tx
 * status, not on a queued-overlay illusion.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const STATE_MACHINE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /jobs/{id} {
      allow read: if true;
      allow create: if request.resource.data.status == 'pending';
      allow update: if (
          (resource.data.status == 'pending' && request.resource.data.status == 'active')
          || (resource.data.status == 'active' && request.resource.data.status == 'done')
      );
      allow delete: if false;
    }
  }
}`;

describe('transactions / state-machine fixture', () => {
  test('pending → active commits', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'pending' } },
    });

    const result = env.transaction((tx) => {
      const status = (tx.get('jobs/j1').data() as { status: string }).status;
      if (status === 'pending') {
        tx.update('jobs/j1', { status: 'active' });
      }
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'active' });
  });

  test('pending → done denied (must transit through active)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'pending' } },
    });

    const result = env.transaction((tx) => {
      tx.get('jobs/j1');
      tx.update('jobs/j1', { status: 'done' });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'pending' });
  });

  test('active → done commits', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'active' } },
    });

    const result = env.transaction((tx) => {
      tx.get('jobs/j1');
      tx.update('jobs/j1', { status: 'done' });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'done' });
  });

  test('done → anything denied (terminal)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'done' } },
    });

    const result = env.transaction((tx) => {
      tx.get('jobs/j1');
      tx.update('jobs/j1', { status: 'active' });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'done' });
  });

  test('multi-write tx that crosses two branches: each rule sees pre-tx state (probe 0.E canary)', () => {
    // The canary: queue two writes whose rule eligibility depends on
    // the SECOND write seeing the FIRST. If 0.E extrapolation is
    // correct (per-write eval against pre-tx state, no overlay), the
    // second write's rule sees the ORIGINAL `status`, not the queued
    // value. So a tx that updates jobs/j1 from pending to active AND
    // then queues another update from active to done in the same tx
    // should be DENIED on the second write's rule (status is still
    // 'pending' from rules' perspective).
    //
    // If we ever flip 0.E to "rules see overlay," this test must be
    // updated and a follow-up probe filed against production.
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'pending' } },
    });

    const result = env.transaction((tx) => {
      tx.get('jobs/j1');
      tx.update('jobs/j1', { status: 'active' });
      tx.update('jobs/j1', { status: 'done' });
    }, { auth: { uid: 'a' } });

    // Same-path multi-update merges (probe 0.D), so the merged op is
    // {status: 'done'} — and the rule sees pre-tx status 'pending' →
    // request 'done'. That transition is denied.
    expect(result.allowed).toBe(false);
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'pending' });
  });

  test('parallel jobs: two independent state machines in one tx', () => {
    // Cross-doc coverage: two distinct jobs, each transitioning. Both
    // rules pass against pre-tx state → both writes apply atomically.
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: {
        'jobs/j1': { status: 'pending' },
        'jobs/j2': { status: 'active' },
      },
    });

    const result = env.transaction((tx) => {
      tx.get('jobs/j1');
      tx.get('jobs/j2');
      tx.update('jobs/j1', { status: 'active' });
      tx.update('jobs/j2', { status: 'done' });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'active' });
    expect(env.getDocument('jobs/j2')).toEqual({ status: 'done' });
  });

  test('one job invalid → both writes roll back (atomic)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: STATE_MACHINE_RULES,
      documents: {
        'jobs/j1': { status: 'pending' },
        'jobs/j2': { status: 'done' },   // terminal — any update denied
      },
    });

    const result = env.transaction((tx) => {
      tx.get('jobs/j1');
      tx.get('jobs/j2');
      tx.update('jobs/j1', { status: 'active' });
      tx.update('jobs/j2', { status: 'active' });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    // Atomic — j1 also rolled back even though its rule allowed
    expect(env.getDocument('jobs/j1')).toEqual({ status: 'pending' });
    expect(env.getDocument('jobs/j2')).toEqual({ status: 'done' });
  });
});
