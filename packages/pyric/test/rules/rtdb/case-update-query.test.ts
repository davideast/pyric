import { describe, expect, test } from 'bun:test';
import { rtdbRules } from 'pyric/rules';

const rules = {
  rules: {
    '.read': false,
    '.write': false,
    scores: { '.write': 'auth != null', '.validate': 'newData.isNumber()' },
    totals: {
      '.write': 'auth != null',
      '.validate': "newData.val() == newData.parent().child('scores').val() + 1",
    },
    items: {
      '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid",
      '.write': 'auth != null',
    },
    feed: {
      '.read': 'query.orderByKey == true && query.limitToFirst <= 10',
    },
    ranged: {
      '.read': 'query.startAt == 5 && query.endAt == 9',
    },
    flag: { '.write': 'auth != null', '.validate': 'newData.val() == true' },
  },
};

describe('rtdbRules simulate: multi-path update cases', () => {
  test('an update is DENY when any written path fails .validate, and names that path', () => {
    const [result] = rtdbRules(rules).simulate([
      { expectation: 'DENY', operation: 'update', path: '/', auth: 'alice', newData: { scores: 1, totals: 'x' } },
    ]).cases;
    expect(result.decision).toBe('DENY');
    expect(result.matchedPath).toContain('totals');
  });

  test('the same paths written as separate writes are each judged on their own', () => {
    const { cases } = rtdbRules(rules).simulate([
      { expectation: 'ALLOW', operation: 'write', path: '/scores', auth: 'alice', newData: 1 },
      { expectation: 'DENY', operation: 'write', path: '/totals', auth: 'alice', newData: 2 },
    ]);
    expect(cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY']);
  });

  test('a path written in the same update is visible to .validate as newData', () => {
    const [result] = rtdbRules(rules).simulate([
      { expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', newData: { scores: 4, totals: 5 } },
    ]).cases;
    expect(result.decision).toBe('ALLOW');
  });

  test('keys are relative to the case path', () => {
    const [nested] = rtdbRules({ rules: { rooms: { $id: { '.write': 'auth != null' } } } }).simulate([
      { expectation: 'ALLOW', operation: 'update', path: '/rooms', auth: 'alice', newData: { 'r1/title': 'x', 'r2/title': 'y' } },
    ]).cases;
    expect(nested.decision).toBe('ALLOW');
  });

  test('an update by an unauthenticated caller is DENY', () => {
    const [result] = rtdbRules(rules).simulate([
      { expectation: 'DENY', operation: 'update', path: '/', auth: null, newData: { scores: 1 } },
    ]).cases;
    expect(result.decision).toBe('DENY');
    expect(result.passed).toBe(true);
  });

  test('an update whose newData is not an object is unsupported with a reason', () => {
    const [result] = rtdbRules(rules).simulate([
      { expectation: 'ALLOW', operation: 'update', path: '/', auth: 'alice', newData: 5 },
    ]).cases;
    expect(result.unsupported).toBe(true);
    expect(result.reason).toContain('update');
  });
});

describe('rtdbRules simulate: query read cases', () => {
  const read = (path: string, query: object | undefined, auth: string | null = 'alice') =>
    rtdbRules(rules).simulate([
      { expectation: 'ALLOW', operation: 'read', path, auth, ...(query === undefined ? {} : { query }) },
    ]).cases[0];

  test('a query that names the owner is ALLOW, and the same read without a query is DENY', () => {
    expect(read('/items', { orderByChild: 'owner', equalTo: 'alice' }).decision).toBe('ALLOW');
    expect(read('/items', undefined).decision).toBe('DENY');
    expect(read('/items', { orderByChild: 'owner', equalTo: 'bob' }).decision).toBe('DENY');
  });

  test('orderByKey and limits reach query.*', () => {
    expect(read('/feed', { orderByKey: true, limitToFirst: 10 }).decision).toBe('ALLOW');
    expect(read('/feed', { orderByKey: true, limitToFirst: 11 }).decision).toBe('DENY');
  });

  test('ranges reach query.startAt and query.endAt', () => {
    expect(read('/ranged', { orderByValue: true, startAt: 5, endAt: 9 }).decision).toBe('ALLOW');
    expect(read('/ranged', { orderByValue: true, startAt: 1, endAt: 9 }).decision).toBe('DENY');
  });

  test('a query on a write case, two orderBy members, or a bad limit is unsupported with a reason', () => {
    const run = (c: Record<string, unknown>) =>
      rtdbRules(rules).simulate([
        { expectation: 'ALLOW', path: '/items', auth: 'alice', operation: 'read', ...c },
      ]).cases[0];
    expect(run({ operation: 'write', newData: 1, query: { orderByKey: true } }).unsupported).toBe(true);
    expect(run({ query: { orderByKey: true, orderByValue: true } }).unsupported).toBe(true);
    expect(run({ query: { limitToFirst: 0 } }).unsupported).toBe(true);
  });
});

describe('rtdbRules simulate: scalar writes', () => {
  test('a scalar newData is evaluated against .validate', () => {
    const { cases } = rtdbRules(rules).simulate([
      { expectation: 'ALLOW', operation: 'write', path: '/scores', auth: 'alice', newData: 5 },
      { expectation: 'DENY', operation: 'write', path: '/scores', auth: 'alice', newData: 'five' },
      { expectation: 'ALLOW', operation: 'write', path: '/flag', auth: 'alice', newData: true },
    ]);
    expect(cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY', 'ALLOW']);
  });
});
