/**
 * getafter-batch fix.
 *
 * Production semantics: `getAfter(path)` inside a Firestore rule evaluates
 * the document at `path` AS IT WILL BE once the CURRENT batch/transaction
 * commits — it sees every OTHER write in the same atomic group, not just
 * the write under evaluation. Before this fix, `LocalEnvironment.batch()`
 * and `.transaction()` evaluated each op's rules with `getAfter()` only
 * aware of that op's own pending write; a sibling doc's pending write in
 * the same batch was invisible (fell through to pre-batch `get()`).
 *
 * These tests exercise the fix through `LocalEnvironment` (not the bare
 * `SimulateFirestoreRulesHandler`, which is covered in
 * `get-after.test.ts`) because the bug lives in how the sandbox wires
 * per-op `simulate()` calls together for a batch/transaction, not in the
 * rules evaluator's per-call `getAfter()` handling itself.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

// doc A's write is gated on doc B's PROJECTED post-batch state — the
// canonical getAfter-sees-sibling-write scenario.
const RULES_CROSS_DOC = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/a {
      allow create, update: if getAfter(/databases/$(database)/documents/docs/b).data.x == 1;
    }
    match /docs/b {
      allow create, update: if request.auth != null;
    }
  }
}`;

describe('getAfter — batch write visibility', () => {
  test('ALLOWS when the sibling write in the same batch sets the field getAfter reads', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_CROSS_DOC });

    const result = env.batch([
      { method: 'create', path: 'docs/a', data: { note: 'gated on b' } },
      { method: 'create', path: 'docs/b', data: { x: 1 } },
    ], { uid: 'u1' });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('docs/a')).toEqual({ note: 'gated on b' });
    expect(env.getDocument('docs/b')).toEqual({ x: 1 });
  });

  test('DENIES when B is not in the batch and current B data lacks x=1', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_CROSS_DOC,
      documents: { 'docs/b': { x: 0 } },
    });

    const result = env.batch([
      { method: 'create', path: 'docs/a', data: { note: 'gated on b' } },
    ], { uid: 'u1' });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('docs/a')).toBe(null);
  });

  test('ALLOWS when B is not in the batch but its CURRENT data already has x=1', () => {
    // getAfter on an untouched doc == get() of its current data.
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_CROSS_DOC,
      documents: { 'docs/b': { x: 1 } },
    });

    const result = env.batch([
      { method: 'create', path: 'docs/a', data: { note: 'gated on b' } },
    ], { uid: 'u1' });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('docs/a')).toEqual({ note: 'gated on b' });
  });

  test('batch DELETE of B makes getAfter(B).exists false, even though B currently exists', () => {
    const RULES_EXISTS_AFTER = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/a {
      allow create: if !existsAfter(/databases/$(database)/documents/docs/b);
    }
    match /docs/b {
      allow delete: if request.auth != null;
    }
  }
}`;
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_EXISTS_AFTER,
      documents: { 'docs/b': { x: 1 } },
    });

    // Sanity: B currently exists, so a batch that does NOT delete B is denied.
    const withoutDelete = env.batch(
      [{ method: 'create', path: 'docs/a', data: {} }],
      { uid: 'u1' },
    );
    expect(withoutDelete.allowed).toBe(false);

    const withDelete = env.batch([
      { method: 'create', path: 'docs/a', data: {} },
      { method: 'delete', path: 'docs/b' },
    ], { uid: 'u1' });

    expect(withDelete.allowed).toBe(true);
    expect(env.getDocument('docs/a')).toEqual({});
    expect(env.getDocument('docs/b')).toBe(null);
  });

  test('transaction: doc A rule sees doc B write queued earlier in the same transaction', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_CROSS_DOC });

    const result = env.transaction((tx) => {
      tx.create('docs/b', { x: 1 });
      tx.create('docs/a', { note: 'gated on b' });
    }, { auth: { uid: 'u1' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('docs/a')).toEqual({ note: 'gated on b' });
    expect(env.getDocument('docs/b')).toEqual({ x: 1 });
  });

  test('transaction: doc A rule sees doc B write queued LATER in the same transaction (order-independent)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_CROSS_DOC });

    const result = env.transaction((tx) => {
      tx.create('docs/a', { note: 'gated on b' });
      tx.create('docs/b', { x: 1 });
    }, { auth: { uid: 'u1' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('docs/a')).toEqual({ note: 'gated on b' });
    expect(env.getDocument('docs/b')).toEqual({ x: 1 });
  });

  test('transaction: DENIES when the sibling write in the tx does not satisfy getAfter', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_CROSS_DOC });

    const result = env.transaction((tx) => {
      tx.create('docs/a', { note: 'gated on b' });
      tx.create('docs/b', { x: 0 }); // wrong value — getAfter(b).data.x != 1
    }, { auth: { uid: 'u1' } });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('docs/a')).toBe(null);
    expect(env.getDocument('docs/b')).toBe(null);
  });

  test('atomicity: one denied write in the batch rejects the whole batch (getAfter-gated doc included)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: RULES_CROSS_DOC });

    // A is gated on B's projected data; B's own rule ALSO requires auth,
    // which it has — so A should pass. Flip B's payload so A's getAfter
    // check fails, and confirm NEITHER write lands (not just A's).
    const result = env.batch([
      { method: 'create', path: 'docs/a', data: { note: 'gated on b' } },
      { method: 'create', path: 'docs/b', data: { x: 999 } },
    ], { uid: 'u1' });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('docs/a')).toBe(null);
    expect(env.getDocument('docs/b')).toBe(null);
  });

  test('single-op execute() is unaffected — getAfter on an unrelated path still reads current committed data', () => {
    // Guards against a regression where batchProjection leaks into the
    // single-write execute() path (it must stay undefined there).
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES_CROSS_DOC,
      documents: { 'docs/b': { x: 1 } },
    });

    const result = env.execute({ method: 'create', path: 'docs/a', data: { note: 'solo' }, auth: { uid: 'u1' } });
    expect(result.allowed).toBe(true);
    expect(env.getDocument('docs/a')).toEqual({ note: 'solo' });
  });
});
