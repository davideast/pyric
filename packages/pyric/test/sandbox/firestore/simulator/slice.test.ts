/**
 * Unit tests for range slice `[i:j]`.
 *
 * Production (Firestore Rules Test API) evaluates `x[start:end]` on a list or
 * string of size n as a sub-list or substring with `end` exclusive, after
 * three checks, each an evaluation error that denies:
 *   - `start` must be in [0, n): "Index out of bound error. Index: [start]".
 *   - `end - 1` must be in [0, n): "Index out of bound error. Index: [end - 1]".
 *     So `[0:0]` is an error, `[i:i]` with 0 < i < n is empty, and any slice
 *     of an empty list or string is an error.
 *   - `start` must not exceed `end`: "Illegal range error".
 *
 * Production verdicts: corpus scenario `range-slice-list-and-string`.
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

  test('end OOB denies', () => {
    expectDeny(
      "request.resource.data.arr[1:99].size() == 3",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('start OOB denies', () => {
    expectDeny(
      "request.resource.data.arr[99:100].size() == 0",
      { arr: ['a', 'b', 'c', 'd'] },
    );
  });

  test('slice on empty list denies', () => {
    expectDeny(
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

  test('end OOB denies', () => {
    expectDeny(
      "request.resource.data.s[6:99] == 'world'",
      { s: 'hello world' },
    );
  });

  test('start OOB denies', () => {
    expectDeny(
      "request.resource.data.s[99:100] == ''",
      { s: 'hello' },
    );
  });

  test('slice on empty string denies', () => {
    expectDeny(
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

describe('Slice — production bounds', () => {
  // Each row is a production verdict from the Firestore Rules Test API; the
  // message is the evaluation error production reports for the DENY rows.
  const list = { arr: ['a', 'b', 'c', 'd'] };
  const str = { s: 'hello' };
  test.each([
    ['request.resource.data.arr[0:0].size() == 0', list, 'Index out of bound error. Index: [-1] , size: [4].'],
    ['request.resource.data.arr[4:4].size() == 0', list, 'Index out of bound error. Index: [4] , size: [4].'],
    ['request.resource.data.arr[1:0].size() == 0', list, 'Index out of bound error. Index: [-1] , size: [4].'],
    ['request.resource.data.arr[2:1].size() == 0', list, 'Illegal range error. From index: [2] , To index: [1].'],
    ['request.resource.data.arr[3:1].size() == 0', list, 'Illegal range error. From index: [3] , To index: [1].'],
    ['request.resource.data.arr[1:5].size() == 3', list, 'Index out of bound error. Index: [4] , size: [4].'],
    ['request.resource.data.arr[-1:2].size() == 0', list, 'Index out of bound error. Index: [-1] , size: [4].'],
    ['request.resource.data.arr[1:-1].size() == 0', list, 'Index out of bound error. Index: [-2] , size: [4].'],
    ["request.resource.data.s[0:0] == ''", str, 'Index out of bound error. Index: [-1] , size: [5].'],
    ["request.resource.data.s[5:5] == ''", str, 'Index out of bound error. Index: [5] , size: [5].'],
    ["request.resource.data.s[2:1] == ''", str, 'Illegal range error. From index: [2] , To index: [1].'],
    ["request.resource.data.s[0:6] == 'hello'", str, 'Index out of bound error. Index: [5] , size: [5].'],
    ['[][0:0] == []', {}, 'Index out of bound error. Index: [0] , size: [0].'],
  ])('%s is an evaluation error', (condition, data, message) => {
    const r = handler.simulate(rules(condition), [{
      description: 'probe', expectation: 'DENY', method: 'create', path: 'docs/d1', auth: { uid: 'u1' }, data,
    }]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.results[0].decision).toBe('DENY');
    expect(r.data.results[0].trace[0]!.verdict).toBe('ERROR');
    expect(r.data.results[0].trace[0]!.message).toBe(message);
  });

  test.each([
    ['request.resource.data.arr[1:1].size() == 0', list],
    ['request.resource.data.arr[3:3].size() == 0', list],
    ["request.resource.data.arr[3:4] == ['d']", list],
    ['request.resource.data.arr[0:4].size() == 4', list],
    ["request.resource.data.s[1:1] == ''", str],
    ["request.resource.data.s[4:4] == ''", str],
    ["request.resource.data.s[4:5] == 'o'", str],
  ])('%s evaluates', (condition, data) => {
    expectAllow(condition, data);
  });
});
