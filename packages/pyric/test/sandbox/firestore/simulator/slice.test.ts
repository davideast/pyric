/**
 * Unit tests for range slice `[i:j]` — Item 4 of REBUILD_PLAN.md.
 *
 * Slice semantics per REBUILD_PLAN type table:
 *   - Lists: `arr[i:j]` returns sub-list, j exclusive.
 *   - Strings: `s[i:j]` returns substring, j exclusive.
 *   - Indices must be non-negative integers.
 *   - Out-of-bounds indices clamp to [0, length].
 *
 * The parity-stress scenario `range-slice-list-and-string` provides the
 * prod-comparison receipt (gated on FIREBASE_SA_BASE64).
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

describe('Slice — list', () => {
  test('mid-slice returns sub-list', () => {
    expectAllow(
      "request.resource.data.arr[1:3].size() == 2",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('slice values match expected leaves', () => {
    expectAllow(
      "request.resource.data.arr[1:3][0] == 'b'",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('slice end is exclusive', () => {
    expectAllow(
      "request.resource.data.arr[0:1].size() == 1",
      { arr: ['a', 'b', 'c'] },
    );
  });

  test('full-list slice', () => {
    expectAllow(
      "request.resource.data.arr[0:4].size() == 4",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('i==j returns empty list', () => {
    expectAllow(
      "request.resource.data.arr[2:2].size() == 0",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('end OOB clamps to length', () => {
    expectAllow(
      "request.resource.data.arr[1:99].size() == 3",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('start OOB returns empty', () => {
    expectAllow(
      "request.resource.data.arr[99:100].size() == 0",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('slice on empty list returns empty', () => {
    expectAllow(
      "request.resource.data.arr[0:0].size() == 0",
      { arr: [] },
    );
  });

  test('slice combined with hasOnly', () => {
    expectAllow(
      "request.resource.data.arr[0:2].hasOnly(['a','b'])",
      { arr: ['a', 'b', 'c'] },
    );
  });

  test('slice mismatch denies', () => {
    expectDeny(
      "request.resource.data.arr[0:2].size() == 5",
      { arr: ['a', 'b', 'c'] },
    );
  });
});

describe('Slice — string', () => {
  test('mid-substring', () => {
    expectAllow(
      "request.resource.data.s[6:11] == 'world'",
      { s: 'hello world' },
    );
  });

  test('prefix', () => {
    expectAllow(
      "request.resource.data.s[0:5] == 'hello'",
      { s: 'hello world' },
    );
  });

  test('end exclusive', () => {
    expectAllow(
      "request.resource.data.s[0:1] == 'h'",
      { s: 'hello' },
    );
  });

  test('full-length substring', () => {
    expectAllow(
      "request.resource.data.s[0:11] == 'hello world'",
      { s: 'hello world' },
    );
  });

  test('i==j returns empty string', () => {
    expectAllow(
      "request.resource.data.s[3:3] == ''",
      { s: 'hello' },
    );
  });

  test('end OOB clamps to length', () => {
    expectAllow(
      "request.resource.data.s[6:99] == 'world'",
      { s: 'hello world' },
    );
  });

  test('start OOB returns empty', () => {
    expectAllow(
      "request.resource.data.s[99:100] == ''",
      { s: 'hello' },
    );
  });

  test('slice on empty string returns empty', () => {
    expectAllow(
      "request.resource.data.s[0:0] == ''",
      { s: '' },
    );
  });
});

describe('Slice — composability', () => {
  test('slice then index', () => {
    expectAllow(
      "request.resource.data.arr[1:3][1] == 'c'",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('slice with computed indices', () => {
    expectAllow(
      "request.resource.data.arr[request.resource.data.i:request.resource.data.j].size() == 2",
      { arr: ['a', 'b', 'c', 'd'], i: 1, j: 3 },
    );
  });

  test('slice in chained method call', () => {
    expectAllow(
      "request.resource.data.arr[0:2].hasAll(['a'])",
      { arr: ['a', 'b', 'c'] },
    );
  });
});

describe('Slice — error cases (DENY via EvalError)', () => {
  test('non-integer start denies', () => {
    expectDeny(
      "request.resource.data.arr[1.5:3].size() == 0",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('negative start denies', () => {
    expectDeny(
      "request.resource.data.arr[-1:3].size() == 0",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('negative end denies', () => {
    expectDeny(
      "request.resource.data.arr[0:-1].size() == 0",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });
});
