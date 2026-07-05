/**
 * Unit tests for Set algebra — Item 5.1 of REBUILD_PLAN.md.
 *
 * Per type table:
 *   Set.difference(other: Set) → Set    items in this not in other
 *   Set.union(other: Set) → Set         items in either
 *   Set.intersection(other: Set) → Set  items in both
 *
 * Sets are constructed via `Map.keys()` or MapDiff methods. Tests chain
 * through `.keys()` to materialize a FirestoreSet, then exercise the new
 * methods. The result is itself a Set so we follow with `.size()` /
 * `.hasOnly(...)` / `.hasAll(...)` to assert contents.
 *
 * Per the impl, `other` may be a Set or a List of strings (matching
 * hasOnly/hasAll/hasAny's signature flexibility).
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

describe('Set.difference', () => {
  test('items in this not in other (list arg)', () => {
    expectAllow(
      "request.resource.data.m.keys().difference(['a','b']).hasOnly(['c'])",
      { m: { a: 1, b: 2, c: 3 } },
    );
  });

  test('full overlap → empty set', () => {
    expectAllow(
      "request.resource.data.m.keys().difference(['a','b','c']).size() == 0",
      { m: { a: 1, b: 2, c: 3 } },
    );
  });

  test('no overlap → original set', () => {
    expectAllow(
      "request.resource.data.m.keys().difference(['x','y']).size() == 3",
      { m: { a: 1, b: 2, c: 3 } },
    );
  });

  test('Set arg (chained .keys() difference)', () => {
    // Use diff(...).addedKeys() (a Set) as the other arg
    expectAllow(
      "request.resource.data.a.keys().difference(request.resource.data.b.keys()).hasOnly(['x'])",
      { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    );
  });
});

describe('Set.union', () => {
  test('items in either (list arg)', () => {
    expectAllow(
      "request.resource.data.m.keys().union(['c','d']).size() == 4",
      { m: { a: 1, b: 2 } },
    );
  });

  test('union with overlap dedupes', () => {
    expectAllow(
      "request.resource.data.m.keys().union(['b','c']).size() == 3",
      { m: { a: 1, b: 2 } },
    );
  });

  test('union of two key sets', () => {
    expectAllow(
      "request.resource.data.a.keys().union(request.resource.data.b.keys()).size() == 3",
      { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    );
  });

  test('union with empty list returns same set', () => {
    expectAllow(
      "request.resource.data.m.keys().union([]).size() == 2",
      { m: { a: 1, b: 2 } },
    );
  });
});

describe('Set.intersection', () => {
  test('items in both (list arg)', () => {
    expectAllow(
      "request.resource.data.m.keys().intersection(['b','c','d']).hasOnly(['b','c'])",
      { m: { a: 1, b: 2, c: 3 } },
    );
  });

  test('no overlap → empty set', () => {
    expectAllow(
      "request.resource.data.m.keys().intersection(['x','y']).size() == 0",
      { m: { a: 1, b: 2 } },
    );
  });

  test('full overlap → original set', () => {
    expectAllow(
      "request.resource.data.m.keys().intersection(['a','b','c']).size() == 3",
      { m: { a: 1, b: 2, c: 3 } },
    );
  });

  test('Set arg', () => {
    expectAllow(
      "request.resource.data.a.keys().intersection(request.resource.data.b.keys()).hasOnly(['y'])",
      { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    );
  });
});

describe('Set methods — composability', () => {
  test('chained: union then difference', () => {
    expectAllow(
      "request.resource.data.m.keys().union(['c']).difference(['a']).hasOnly(['b','c'])",
      { m: { a: 1, b: 2 } },
    );
  });

  test('intersection result feeds into hasAll', () => {
    expectAllow(
      "request.resource.data.m.keys().intersection(['a','b','x']).hasAll(['a','b'])",
      { m: { a: 1, b: 2, c: 3 } },
    );
  });
});

describe('Existing has* methods accept FirestoreSet (added in 5.1)', () => {
  test('hasOnly with set arg', () => {
    expectAllow(
      "request.resource.data.a.keys().hasOnly(request.resource.data.a.keys())",
      { a: { x: 1, y: 2 } },
    );
  });

  test('hasAll with set arg', () => {
    expectAllow(
      "request.resource.data.a.keys().hasAll(request.resource.data.b.keys())",
      { a: { x: 1, y: 2, z: 3 }, b: { x: 1, y: 2 } },
    );
  });

  test('hasAny with set arg', () => {
    expectAllow(
      "request.resource.data.a.keys().hasAny(request.resource.data.b.keys())",
      { a: { x: 1 }, b: { x: 9, y: 8 } },
    );
  });
});
