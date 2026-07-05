/**
 * RULES-LIST parity pack — `list` on a COLLECTION path must evaluate the
 * document-level match block (document wildcard hypothetical, `resource`
 * undefined), as the emulator does.
 *
 * Provenance: user-found 2026-06-10 (conductor log, agent-capability-epic).
 * Every model's draft-validate sweep and any live agent issuing
 * `simulate_firestore_write { method: 'list', path: '<collection>' }` got
 * a structurally-unfixable "No match block found" DENY — e.g.
 * `list menuItems` against `match /menuItems/{id} { allow list: if true }`.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler, type TestCase } from '../../../src/rules';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /menuItems/{id} {
      allow get, list: if true;
    }
    match /orders/{orderId} {
      allow list: if request.auth != null;
      allow get: if request.auth != null && resource.data.userId == request.auth.uid;
    }
    match /users/{uid}/todos/{todoId} {
      allow list: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

const sim = () => new SimulateFirestoreRulesHandler();

function decide(rules: string, tc: Omit<TestCase, 'description' | 'expectation'>) {
  const r = sim().simulate(rules, [
    { description: 'pack', expectation: 'ALLOW', ...tc } as TestCase,
  ]);
  expect(r.success).toBe(true);
  return r.data!.results![0]!;
}

describe('RULES-LIST — list on a collection path', () => {
  test('public list: collection path matches the doc-level block', () => {
    const res = decide(RULES, { method: 'list', path: 'menuItems', auth: null });
    expect(res.decision).toBe('ALLOW');
    expect(res.notes.join(' ')).toContain('document-level match block');
  });

  test('auth-gated list: anon DENY, signed-in ALLOW — the rule evaluates, not the resolver', () => {
    expect(decide(RULES, { method: 'list', path: 'orders', auth: null }).decision).toBe('DENY');
    expect(
      decide(RULES, { method: 'list', path: 'orders', auth: { uid: 'alice' } }).decision,
    ).toBe('ALLOW');
  });

  test('nested subcollection path binds parent wildcards (uid guard works)', () => {
    expect(
      decide(RULES, { method: 'list', path: 'users/alice/todos', auth: { uid: 'alice' } }).decision,
    ).toBe('ALLOW');
    expect(
      decide(RULES, { method: 'list', path: 'users/alice/todos', auth: { uid: 'bob' } }).decision,
    ).toBe('DENY');
  });

  test('doc-style list path still resolves first-attempt with NO synthetic note (back-compat)', () => {
    const res = decide(RULES, { method: 'list', path: 'menuItems/any', auth: null });
    expect(res.decision).toBe('ALLOW');
    expect(res.notes.join(' ')).not.toContain('document-level match block');
  });

  test('non-list methods on a collection path keep strict no-match DENY', () => {
    const res = decide(RULES, { method: 'get', path: 'menuItems', auth: null });
    expect(res.decision).toBe('DENY');
    expect(res.notes.join(' ')).toContain('No match block found');
  });

  test('list on a collection with NO matching block is still no-match DENY', () => {
    const res = decide(RULES, { method: 'list', path: 'unknownColl', auth: { uid: 'a' } });
    expect(res.decision).toBe('DENY');
    expect(res.notes.join(' ')).toContain('No match block found');
  });

  test('the user-found shape: coffee-shop list cases pass on collection paths', () => {
    // Verbatim failure class from the 2026-06-10 live session (Kimi K2.6 /
    // MiniMax M3 traces): every `list <collection>` returned no-match DENY
    // regardless of the ruleset, exhausting DV repair budgets.
    expect(decide(RULES, { method: 'list', path: 'menuItems', auth: { uid: 'alice' } }).decision).toBe(
      'ALLOW',
    );
  });
});
