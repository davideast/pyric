/**
 * Unit tests for Set algebra — Item 5.1 of REBUILD_PLAN.md.
 *
 * Set.difference(other)/union(other)/intersection(other) are NOT covered
 * here. The simulator now abstains (UNSUPPORTED) on all three — every
 * production call to these three FirestoreSet methods hits an unsupported
 * path, so the sim can't faithfully evaluate them. See
 * test/rules/simulator/set-algebra-abstain.test.ts for that coverage.
 *
 * hasOnly/hasAll/hasAny (which also accept a FirestoreSet arg) are
 * unaffected and still exercised below.
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
