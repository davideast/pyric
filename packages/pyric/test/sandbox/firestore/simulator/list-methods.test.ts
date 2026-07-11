/**
 * Unit tests for List methods — Item 5.2 of REBUILD_PLAN.md.
 *
 * Per type table:
 *   List.concat(other: List) → List       concatenation
 *   List.removeAll(other: List) → List    items in this not in other (value equality)
 *   List.toSet() → Set                    convert to Set (dedupe)
 *
 * The parity-stress pack `list-methods-concat-removeall-toset` provides
 * the prod-comparison receipt (gated on FIREBASE_SA_BASE64).
 *
 * toSet().difference()/.union()/.intersection() chaining is not exercised
 * here — the simulator abstains (UNSUPPORTED) on those three FirestoreSet
 * methods; see test/rules/simulator/set-algebra-abstain.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { TestCase } from 'pyric/rules/internal';

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

function expectAllow(condition: string, data: Record<string, unknown>) {
  const tc: TestCase = {
    description: 'probe',
    expectation: 'ALLOW',
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'u1' },
    data,
  };
  const r = handler.simulate(rules(condition), [tc]);
  expect(r.success).toBe(true);
  if (r.success && r.data.results[0].state !== 'PASSED') {
    throw new Error(`Expected ALLOW for \`${condition}\`, got ${r.data.results[0].state}: ${r.data.results[0].debugMessages.join(' | ')}`);
  }
}

function expectDeny(condition: string, data: Record<string, unknown>) {
  const tc: TestCase = {
    description: 'probe',
    expectation: 'DENY',
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'u1' },
    data,
  };
  const r = handler.simulate(rules(condition), [tc]);
  expect(r.success).toBe(true);
  if (r.success && r.data.results[0].state !== 'PASSED') {
    throw new Error(`Expected DENY for \`${condition}\`, got ${r.data.results[0].state}: ${r.data.results[0].debugMessages.join(' | ')}`);
  }
}

describe('List.concat', () => {
  test('basic concat', () => {
    expectAllow(
      "request.resource.data.a.concat(request.resource.data.b).size() == 4",
      { a: ['x', 'y'], b: ['p', 'q'] },
    );
  });

  test('concat preserves order', () => {
    expectAllow(
      "request.resource.data.a.concat(['c'])[2] == 'c'",
      { a: ['a', 'b'] },
    );
  });

  test('concat with empty list returns same list', () => {
    expectAllow(
      "request.resource.data.a.concat([]).size() == 2",
      { a: ['a', 'b'] },
    );
  });

  test('concat empty + non-empty', () => {
    expectAllow(
      "request.resource.data.a.concat(['x']).size() == 1",
      { a: [] },
    );
  });

  test('concat with duplicates does NOT dedupe (lists are ordered, not sets)', () => {
    expectAllow(
      "request.resource.data.a.concat(['a','b']).size() == 4",
      { a: ['a', 'b'] },
    );
  });
});

describe('List.removeAll', () => {
  test('basic removal', () => {
    expectAllow(
      "request.resource.data.a.removeAll(['b']).size() == 2",
      { a: ['a', 'b', 'c'] },
    );
  });

  test('removeAll removes all matching occurrences', () => {
    expectAllow(
      "request.resource.data.a.removeAll(['b']).size() == 2",
      { a: ['b', 'a', 'b', 'c'] },
    );
  });

  test('removeAll with no matches returns same list', () => {
    expectAllow(
      "request.resource.data.a.removeAll(['z']).size() == 3",
      { a: ['a', 'b', 'c'] },
    );
  });

  test('removeAll empty arg → identity', () => {
    expectAllow(
      "request.resource.data.a.removeAll([]).size() == 3",
      { a: ['a', 'b', 'c'] },
    );
  });

  test('removeAll all matches → empty', () => {
    expectAllow(
      "request.resource.data.a.removeAll(['a','b','c']).size() == 0",
      { a: ['a', 'b', 'c'] },
    );
  });

  test('removeAll preserves remaining order', () => {
    expectAllow(
      "request.resource.data.a.removeAll(['b'])[0] == 'a' && request.resource.data.a.removeAll(['b'])[1] == 'c'",
      { a: ['a', 'b', 'c'] },
    );
  });
});

describe('List.toSet', () => {
  test('basic toSet returns Set', () => {
    expectAllow(
      "request.resource.data.a.toSet().size() == 3",
      { a: ['a', 'b', 'c'] },
    );
  });

  test('toSet dedupes', () => {
    expectAllow(
      "request.resource.data.a.toSet().size() == 3",
      { a: ['a', 'b', 'c', 'a', 'b'] },
    );
  });

  test('toSet result supports hasOnly', () => {
    expectAllow(
      "request.resource.data.a.toSet().hasOnly(['a','b','c'])",
      { a: ['a', 'b', 'c', 'a'] },
    );
  });

  test('toSet result supports hasAll', () => {
    expectAllow(
      "request.resource.data.a.toSet().hasAll(['a','b'])",
      { a: ['a', 'b', 'c'] },
    );
  });

  // toSet().difference()/.union()/.intersection() chaining is NOT covered
  // here. The simulator abstains (UNSUPPORTED) on all three set-algebra
  // methods regardless of what materialized the Set — see
  // test/rules/simulator/set-algebra-abstain.test.ts ("List.toSet().difference()
  // abstains" covers the toSet() chaining case specifically).

  test('toSet on empty list', () => {
    expectAllow(
      "request.resource.data.a.toSet().size() == 0",
      { a: [] },
    );
  });
});

describe('List methods — composability', () => {
  test('concat then removeAll', () => {
    expectAllow(
      "request.resource.data.a.concat(['c','d']).removeAll(['a','d']).size() == 2",
      { a: ['a', 'b'] },
    );
  });

  test('concat then toSet dedupes', () => {
    expectAllow(
      "request.resource.data.a.concat(request.resource.data.a).toSet().size() == 3",
      { a: ['a', 'b', 'c'] },
    );
  });

  test('removeAll then size mismatch denies', () => {
    expectDeny(
      "request.resource.data.a.removeAll(['a']).size() == 99",
      { a: ['a', 'b', 'c'] },
    );
  });
});

describe('List methods — error cases', () => {
  test('concat with non-list arg denies', () => {
    expectDeny(
      "request.resource.data.a.concat('not-a-list').size() == 0",
      { a: ['a', 'b'] },
    );
  });

  test('removeAll with non-list arg denies', () => {
    expectDeny(
      "request.resource.data.a.removeAll('not-a-list').size() == 0",
      { a: ['a', 'b'] },
    );
  });
});
