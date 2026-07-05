/**
 * Unit tests for `Map.get(key, default)` — Item 3 of REBUILD_PLAN.md.
 *
 * Production behavior was locked in by the Item 0.H probe
 * (map-get-parity-probe.test.ts): production *always* returns `default`
 * on any walk failure (missing top-level key, missing intermediate,
 * non-map intermediate). It never returns `null` from a walk failure.
 *
 * These tests exercise the simulator alone — the parity-stress pack
 * `map-get-string-and-list-form` provides the prod-comparison receipt
 * (gated on FIREBASE_SA_BASE64).
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules';
import type { TestCase } from 'pyric/rules';

const handler = new SimulateFirestoreRulesHandler();

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow create: if ${condition};
    }
  }
}`;
}

function run(condition: string, data: Record<string, unknown>): TestCase[] {
  return [{
    description: 'probe',
    expectation: 'ALLOW',
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'u1' },
    data,
  }];
}

function expectAllow(condition: string, data: Record<string, unknown>) {
  const r = handler.simulate(rules(condition), run(condition, data));
  expect(r.success).toBe(true);
  if (r.success) {
    if (r.data.results[0].state !== 'PASSED') {
      throw new Error(`Expected ALLOW for \`${condition}\`, got ${r.data.results[0].state}: ${r.data.results[0].debugMessages.join(' | ')}`);
    }
  }
}

function expectDeny(condition: string, data: Record<string, unknown>) {
  const r = handler.simulate(rules(condition), [{
    description: 'probe',
    expectation: 'DENY',
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'u1' },
    data,
  }]);
  expect(r.success).toBe(true);
  if (r.success) {
    if (r.data.results[0].state !== 'PASSED') {
      throw new Error(`Expected DENY for \`${condition}\`, got ${r.data.results[0].state}: ${r.data.results[0].debugMessages.join(' | ')}`);
    }
  }
}

describe('Map.get — single-key form', () => {
  test('present key returns value', () => {
    expectAllow(
      "request.resource.data.m.get('a', 'DEF') == 'X'",
      { m: { a: 'X' } },
    );
  });

  test('absent key returns default', () => {
    expectAllow(
      "request.resource.data.m.get('z', 'DEF') == 'DEF'",
      { m: { a: 'X' } },
    );
  });

  test('present key with null value returns null (not default — key is present)', () => {
    expectAllow(
      "request.resource.data.m.get('a', 'DEF') == null",
      { m: { a: null } },
    );
  });

  test('numeric default returned when key absent', () => {
    expectAllow(
      "request.resource.data.m.get('z', 0) == 0",
      { m: { a: 1 } },
    );
  });

  test('present-key compare against wrong value denies', () => {
    expectDeny(
      "request.resource.data.m.get('a', 'DEF') == 'WRONG'",
      { m: { a: 'X' } },
    );
  });
});

describe('Map.get — list-form (nested traversal)', () => {
  test('full path present returns leaf', () => {
    expectAllow(
      "request.resource.data.m.get(['a','b','c'], 'DEF') == 'X'",
      { m: { a: { b: { c: 'X' } } } },
    );
  });

  test('leaf missing under existing parent returns default', () => {
    expectAllow(
      "request.resource.data.m.get(['a','b','z'], 'DEF') == 'DEF'",
      { m: { a: { b: { c: 'X' } } } },
    );
  });

  test('intermediate missing returns default', () => {
    expectAllow(
      "request.resource.data.m.get(['a','z','c'], 'DEF') == 'DEF'",
      { m: { a: { b: { c: 'X' } } } },
    );
  });

  test('top-level key missing returns default', () => {
    expectAllow(
      "request.resource.data.m.get(['z','b','c'], 'DEF') == 'DEF'",
      { m: { a: { b: { c: 'X' } } } },
    );
  });

  test('intermediate is a string (cannot descend into non-map) returns default', () => {
    expectAllow(
      "request.resource.data.m.get(['a','b'], 'DEF') == 'DEF'",
      { m: { a: 'leaf' } },
    );
  });

  test('intermediate is an int returns default', () => {
    expectAllow(
      "request.resource.data.m.get(['a','b'], 'DEF') == 'DEF'",
      { m: { a: 7 } },
    );
  });

  test('intermediate is a list returns default', () => {
    // Lists cannot be descended into via key — collapses to default.
    expectAllow(
      "request.resource.data.m.get(['a','b'], 'DEF') == 'DEF'",
      { m: { a: [1, 2, 3] } },
    );
  });

  test('single-element list-form behaves like single-key form (present)', () => {
    expectAllow(
      "request.resource.data.m.get(['a'], 'DEF') == 'X'",
      { m: { a: 'X' } },
    );
  });

  test('single-element list-form (absent) returns default', () => {
    expectAllow(
      "request.resource.data.m.get(['z'], 'DEF') == 'DEF'",
      { m: { a: 'X' } },
    );
  });

  test('two-level traversal returns inner value', () => {
    expectAllow(
      "request.resource.data.m.get(['a','b'], 'DEF') == 'X'",
      { m: { a: { b: 'X' } } },
    );
  });
});

describe('Map.get — default value passthrough', () => {
  test('default can be a map literal', () => {
    expectAllow(
      "request.resource.data.m.get('z', { 'fallback': true }).fallback == true",
      { m: { a: 'X' } },
    );
  });

  test('default can be a list literal', () => {
    expectAllow(
      "request.resource.data.m.get('z', ['x','y']).size() == 2",
      { m: { a: 'X' } },
    );
  });

  test('default expression only evaluated as needed (returned for miss)', () => {
    // Default is computed regardless in this evaluator (eager arg eval).
    // The contract is only that the *returned* value is the default on miss.
    expectAllow(
      "request.resource.data.m.get('z', request.auth.uid) == 'u1'",
      { m: { a: 'X' } },
    );
  });
});
