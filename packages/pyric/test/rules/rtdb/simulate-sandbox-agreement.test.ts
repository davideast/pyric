import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  endAt,
  equalTo,
  get,
  getDatabase,
  limitToFirst,
  orderByChild,
  orderByKey,
  orderByValue,
  query,
  ref,
  sandbox,
  set,
  startAt,
  update,
  type QueryConstraint,
} from 'pyric/database';
import { rtdbRules, type RtdbCaseQuery } from 'pyric/rules';

// A request that no `.read` or `.write` rule grants is denied, whether or not
// the deepest rules node on its path carries a rule of that kind. The sandbox
// and `simulate` answer each request the same way.
const rules = {
  rules: {
    '.read': false,
    '.write': false,
    rooms: {
      $id: {
        '.read': 'auth != null',
        '.write': "auth != null && newData.child('n').val() < 10",
        n: { '.validate': 'newData.isNumber()' },
      },
    },
    reports: { $id: { '.read': 'auth != null' } },
  },
};

type Db = ReturnType<typeof getDatabase>;
const cases: { label: string; operation: 'read' | 'write'; path: string; newData?: unknown; expected: 'ALLOW' | 'DENY'; run: (db: Db) => Promise<unknown> }[] = [
  { label: 'write under a node with only .validate, ancestor .write false', operation: 'write', path: '/rooms/r1/n', newData: 50, expected: 'DENY', run: (db) => set(ref(db, 'rooms/r1/n'), 50) },
  { label: 'write under a node with only .validate, ancestor .write true', operation: 'write', path: '/rooms/r1/n', newData: 5, expected: 'ALLOW', run: (db) => set(ref(db, 'rooms/r1/n'), 5) },
  { label: 'write under a node with only .read', operation: 'write', path: '/reports/x', newData: 1, expected: 'DENY', run: (db) => set(ref(db, 'reports/x'), 1) },
  { label: 'write outside every rules node', operation: 'write', path: '/elsewhere', newData: 1, expected: 'DENY', run: (db) => set(ref(db, 'elsewhere'), 1) },
  { label: 'read of a node with only children', operation: 'read', path: '/rooms', expected: 'DENY', run: (db) => get(ref(db, 'rooms')) },
  { label: 'read granted below a node with only children', operation: 'read', path: '/rooms/r1', expected: 'ALLOW', run: (db) => get(ref(db, 'rooms/r1')) },
];

describe('RTDB simulate agrees with the sandbox when no rule grants', () => {
  for (const c of cases) {
    test(c.label, async () => {
      const box = initializeSandbox();
      sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
      let verdict: 'ALLOW' | 'DENY' = 'ALLOW';
      try {
        await c.run(getDatabase(box.withAuth({ uid: 'alice' })));
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(rules).simulate([
        { expectation: c.expected, operation: c.operation, path: c.path, auth: { uid: 'alice' }, ...(c.newData === undefined ? {} : { newData: c.newData }) },
      ]).cases;
      expect(verdict).toBe(c.expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }
});

// Production verdicts from a deploy-observe-restore capture: `==` and `!=`
// compare operands of different types without converting either, so a
// `.validate` that expects one type denies a value of another type.
const equalityCases: Array<[validate: string, value: unknown, expected: 'ALLOW' | 'DENY']> = [
  ["newData.val() == '5'", 5, 'DENY'],
  ["newData.val() == '5'", '5', 'ALLOW'],
  ["newData.val() != '5'", 5, 'ALLOW'],
  ["newData.val() != '5'", '5', 'DENY'],
  ['newData.val() == true', 1, 'DENY'],
  ['newData.val() == true', true, 'ALLOW'],
  ['newData.val() != true', 1, 'ALLOW'],
  ['newData.val() != true', true, 'DENY'],
  ['newData.val() == 0', false, 'DENY'],
  ['newData.val() == 0', 0, 'ALLOW'],
  ["newData.val() == ''", false, 'DENY'],
  ["newData.val() == '1'", true, 'DENY'],
  ["newData.val() == '1'", '1', 'ALLOW'],
  ["newData.val() != '1'", true, 'ALLOW'],
  ['newData.val() == 1.0', 1, 'ALLOW'],
];

describe('RTDB simulate agrees with the sandbox on == and != across types', () => {
  for (const [validate, value, expected] of equalityCases) {
    test(`${validate} with ${JSON.stringify(value)}`, async () => {
      const equalityRules = { rules: { a: { '.write': 'auth != null', '.validate': validate } } };
      const box = initializeSandbox();
      sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), equalityRules);
      let verdict: 'ALLOW' | 'DENY' = 'ALLOW';
      try {
        await set(ref(getDatabase(box.withAuth({ uid: 'alice' })), 'a'), value);
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(equalityRules).simulate([
        { expectation: expected, operation: 'write', path: '/a', auth: { uid: 'alice' }, newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
    });
  }
});

// Production verdicts from deploy-observe-restore captures: a rule that fails
// at evaluation, such as a string method called on a number, fails as that
// rule. A `.validate` or `.write` that errors denies the write, and an
// erroring ancestor `.write` leaves a descendant `.write` to grant.
const errorRules = {
  rules: {
    a: { '.write': 'auth != null', '.validate': "newData.val().toUpperCase() == 'A'" },
    w: { '.write': "newData.val().toUpperCase() == 'OK'", open: { '.write': 'auth != null' } },
  },
};
const errorCases: Array<[label: string, path: string, value: unknown, expected: 'ALLOW' | 'DENY']> = [
  ['.validate calling a string method on a number', '/a', 5, 'DENY'],
  ['.validate calling a string method on a string', '/a', 'a', 'ALLOW'],
  ['.write calling a string method on a number', '/w', 5, 'DENY'],
  ['erroring ancestor .write, descendant .write grants', '/w/open', 5, 'ALLOW'],
];

describe('RTDB simulate agrees with the sandbox on rules that error at evaluation', () => {
  for (const [label, path, value, expected] of errorCases) {
    test(label, async () => {
      const box = initializeSandbox();
      sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), errorRules);
      let verdict: 'ALLOW' | 'DENY' = 'ALLOW';
      try {
        await set(ref(getDatabase(box.withAuth({ uid: 'u' })), path.slice(1)), value);
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(errorRules).simulate([
        { expectation: expected, operation: 'write', path, auth: 'u', newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }
});

// Multi-path updates, query reads and scalar writes reach the engine through a
// case the same way the SDK sends them. The sandbox and `simulate` give each
// the same verdict.
const reachRules = {
  rules: {
    '.read': false,
    '.write': false,
    scores: { '.write': 'auth != null', '.validate': 'newData.isNumber()' },
    totals: {
      '.write': 'auth != null',
      '.validate': "newData.val() == newData.parent().child('scores').val() + 1",
    },
    flag: { '.write': 'auth != null', '.validate': 'newData.val() == true' },
    rooms: { $id: { title: { '.write': "auth != null && newData.val() != 'banned'" } } },
    items: {
      '.indexOn': ['owner'],
      '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid",
    },
    feed: { '.read': 'query.orderByKey == true && query.limitToFirst <= 10' },
    ranged: { '.indexOn': ['.value'], '.read': 'query.startAt == 5 && query.endAt == 9' },
  },
};

type Verdict = 'ALLOW' | 'DENY';

async function sandboxVerdict(
  as: string | null,
  run: (db: Db) => Promise<unknown>,
): Promise<Verdict> {
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), reachRules);
  const db = getDatabase(as === null ? box : box.withAuth({ uid: as }));
  try {
    await run(db);
    return 'ALLOW';
  } catch (error) {
    // Only a rules denial is a verdict; any other failure is a broken case.
    const code = String((error as { code?: string }).code ?? error);
    if (!/permission[_-]denied/i.test(code)) throw error;
    return 'DENY';
  }
}

const updateCases: Array<[label: string, as: string | null, patch: Record<string, unknown>, expected: Verdict]> = [
  ['every written path passes', 'alice', { scores: 4, totals: 5 }, 'ALLOW'],
  ['a sibling path in the same update changes what .validate reads', 'alice', { scores: 4, totals: 9 }, 'DENY'],
  ['one written path fails .validate', 'alice', { scores: 'x', flag: true }, 'DENY'],
  ['a nested multi-path key', 'alice', { 'rooms/r1/title': 'hello', 'rooms/r2/title': 'hi' }, 'ALLOW'],
  ['a nested path whose rule denies', 'alice', { 'rooms/r1/title': 'hello', 'rooms/r2/title': 'banned' }, 'DENY'],
  ['an unauthenticated update', null, { scores: 1 }, 'DENY'],
];

describe('RTDB simulate agrees with the sandbox on multi-path updates', () => {
  for (const [label, as, patch, expected] of updateCases) {
    test(label, async () => {
      const verdict = await sandboxVerdict(as, (db) => update(ref(db), patch as never));
      const [result] = rtdbRules(reachRules).simulate([
        { expectation: expected, operation: 'update', path: '/', auth: as, newData: patch },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }
});

const queryCases: Array<{
  label: string;
  path: string;
  query: RtdbCaseQuery;
  constraints: QueryConstraint[];
  expected: Verdict;
}> = [
  { label: 'equalTo the caller on the owner child', path: '/items', query: { orderByChild: 'owner', equalTo: 'alice' }, constraints: [orderByChild('owner'), equalTo('alice')], expected: 'ALLOW' },
  { label: 'equalTo another user', path: '/items', query: { orderByChild: 'owner', equalTo: 'bob' }, constraints: [orderByChild('owner'), equalTo('bob')], expected: 'DENY' },
  { label: 'orderByKey within the limit', path: '/feed', query: { orderByKey: true, limitToFirst: 10 }, constraints: [orderByKey(), limitToFirst(10)], expected: 'ALLOW' },
  { label: 'orderByKey over the limit', path: '/feed', query: { orderByKey: true, limitToFirst: 11 }, constraints: [orderByKey(), limitToFirst(11)], expected: 'DENY' },
  { label: 'a range that matches', path: '/ranged', query: { orderByValue: true, startAt: 5, endAt: 9 }, constraints: [orderByValue(), startAt(5), endAt(9)], expected: 'ALLOW' },
  { label: 'a range that does not match', path: '/ranged', query: { orderByValue: true, startAt: 1, endAt: 9 }, constraints: [orderByValue(), startAt(1), endAt(9)], expected: 'DENY' },
];

describe('RTDB simulate agrees with the sandbox on query reads', () => {
  for (const c of queryCases) {
    test(c.label, async () => {
      const verdict = await sandboxVerdict('alice', (db) => get(query(ref(db, c.path.slice(1)), ...c.constraints)));
      const [result] = rtdbRules(reachRules).simulate([
        { expectation: c.expected, operation: 'read', path: c.path, auth: 'alice', query: c.query },
      ]).cases;
      expect(verdict).toBe(c.expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }

  test('the same read without a query is DENY in both', async () => {
    const verdict = await sandboxVerdict('alice', (db) => get(ref(db, 'items')));
    const [result] = rtdbRules(reachRules).simulate([
      { expectation: 'DENY', operation: 'read', path: '/items', auth: 'alice' },
    ]).cases;
    expect(verdict).toBe('DENY');
    expect(result.decision).toBe('DENY');
  });
});

const scalarCases: Array<[label: string, path: string, value: unknown, expected: Verdict]> = [
  ['a number where a number is required', '/scores', 5, 'ALLOW'],
  ['a string where a number is required', '/scores', 'five', 'DENY'],
  ['true where true is required', '/flag', true, 'ALLOW'],
  ['false where true is required', '/flag', false, 'DENY'],
];

describe('RTDB simulate agrees with the sandbox on scalar writes', () => {
  for (const [label, path, value, expected] of scalarCases) {
    test(label, async () => {
      const verdict = await sandboxVerdict('alice', (db) => set(ref(db, path.slice(1)), value as never));
      const [result] = rtdbRules(reachRules).simulate([
        { expectation: expected, operation: 'write', path, auth: 'alice', newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
    });
  }
});
