import { describe, test, expect } from 'bun:test';
import { DataSnapshot, evaluateRtdbExpression } from '../../../../src/rules/rtdb/grammar/simulator.js';

function evalExpr(raw: string, ctx: Parameters<typeof evaluateRtdbExpression>[1]) {
  return evaluateRtdbExpression(raw, ctx);
}

const baseCtx = {
  auth: null,
  data: new DataSnapshot(null),
  newData: new DataSnapshot(null),
  root: new DataSnapshot({}),
  now: Date.now(),
  pathVariableBindings: {},
};

describe('DataSnapshot', () => {
  test('val() returns the underlying value', () => {
    const snap = new DataSnapshot({ name: 'Alice' });
    expect(snap.val()).toEqual({ name: 'Alice' });
  });

  test('exists() returns true when value is not null', () => {
    expect(new DataSnapshot('hello').exists()).toBe(true);
    expect(new DataSnapshot(null).exists()).toBe(false);
  });

  test('child() returns a DataSnapshot for the child path', () => {
    const snap = new DataSnapshot({ users: { alice: { age: 30 } } });
    expect(snap.child('users/alice/age').val()).toBe(30);
  });

  test('child() returns null DataSnapshot for missing path', () => {
    const snap = new DataSnapshot({ users: {} });
    expect(snap.child('users/bob').exists()).toBe(false);
  });

  test('hasChild() returns true when child exists', () => {
    const snap = new DataSnapshot({ name: 'Alice' });
    expect(snap.hasChild('name')).toBe(true);
    expect(snap.hasChild('age')).toBe(false);
  });

  test('isString() returns true for string values', () => {
    expect(new DataSnapshot('hello').isString()).toBe(true);
    expect(new DataSnapshot(42).isString()).toBe(false);
  });

  test('isNumber() returns true for number values', () => {
    expect(new DataSnapshot(42).isNumber()).toBe(true);
    expect(new DataSnapshot('42').isNumber()).toBe(false);
  });

  test('isBoolean() returns true for boolean values', () => {
    expect(new DataSnapshot(true).isBoolean()).toBe(true);
    expect(new DataSnapshot('true').isBoolean()).toBe(false);
  });

  test('hasChildren() returns true when object has keys', () => {
    expect(new DataSnapshot({ a: 1 }).hasChildren()).toBe(true);
    expect(new DataSnapshot({}).hasChildren()).toBe(false);
    expect(new DataSnapshot(null).hasChildren()).toBe(false);
  });

  test('hasChildren(keys) requires ALL listed keys to be present', () => {
    const snap = new DataSnapshot({ title: 't', body: 'b' });
    expect(snap.hasChildren(['title', 'body'])).toBe(true);
    expect(snap.hasChildren(['title'])).toBe(true);
    // Missing `body` — prod denies; the sandbox previously dropped the arg
    // and returned "has any children" (true), the bug this closes.
    expect(new DataSnapshot({ title: 't' }).hasChildren(['title', 'body'])).toBe(false);
    // No children at all.
    expect(new DataSnapshot(null).hasChildren(['title'])).toBe(false);
  });
});

describe('evaluateRtdbExpression', () => {
  test('auth.uid == "abc" with matching auth returns true', () => {
    const ctx = {
      ...baseCtx,
      auth: { uid: 'abc', token: {} },
    };
    expect(evalExpr('auth.uid == "abc"', ctx)).toBe(true);
  });

  test('auth.uid == "abc" with non-matching auth returns false', () => {
    const ctx = {
      ...baseCtx,
      auth: { uid: 'xyz', token: {} },
    };
    expect(evalExpr('auth.uid == "abc"', ctx)).toBe(false);
  });

  test('auth != null with null auth returns false', () => {
    expect(evalExpr('auth != null', baseCtx)).toBe(false);
  });

  test('auth != null with auth returns true', () => {
    const ctx = { ...baseCtx, auth: { uid: 'user1', token: {} } };
    expect(evalExpr('auth != null', ctx)).toBe(true);
  });

  test('now > 0 returns true', () => {
    expect(evalExpr('now > 0', { ...baseCtx, now: Date.now() })).toBe(true);
  });

  test('data.exists() returns true when data exists', () => {
    const ctx = { ...baseCtx, data: new DataSnapshot({ name: 'Alice' }) };
    expect(evalExpr('data.exists()', ctx)).toBe(true);
  });

  test('data.exists() returns false when data is null', () => {
    expect(evalExpr('data.exists()', baseCtx)).toBe(false);
  });

  test('regex .matches() returns true for matching string', () => {
    const ctx = {
      ...baseCtx,
      data: new DataSnapshot('hello123'),
    };
    expect(evalExpr('data.val().matches(/^[a-z0-9]+$/)', ctx)).toBe(true);
  });

  test('regex .matches() returns false for non-matching string', () => {
    const ctx = {
      ...baseCtx,
      data: new DataSnapshot('UPPERCASE'),
    };
    expect(evalExpr('data.val().matches(/^[a-z0-9]+$/)', ctx)).toBe(false);
  });

  test('ternary short-circuits', () => {
    const ctx = { ...baseCtx, auth: { uid: 'user1', token: {} } };
    expect(evalExpr('auth != null ? true : false', ctx)).toBe(true);
    expect(evalExpr('auth != null ? false : true', ctx)).toBe(false);
  });

  test('logical AND short-circuits on false', () => {
    expect(evalExpr('false && auth != null', baseCtx)).toBe(false);
  });

  test('logical OR short-circuits on true', () => {
    expect(evalExpr('true || auth != null', baseCtx)).toBe(true);
  });

  test('evaluates comparison operators', () => {
    expect(evalExpr('5 > 3', baseCtx)).toBe(true);
    expect(evalExpr('3 >= 3', baseCtx)).toBe(true);
    expect(evalExpr('2 < 1', baseCtx)).toBe(false);
    expect(evalExpr('1 <= 1', baseCtx)).toBe(true);
  });

  test('evaluates unary not', () => {
    expect(evalExpr('!false', baseCtx)).toBe(true);
    expect(evalExpr('!true', baseCtx)).toBe(false);
  });

  test('null auth does not throw when accessing .uid', () => {
    // auth.uid when auth is null returns null (member access on null)
    expect(() => evalExpr('auth.uid == "x"', baseCtx)).not.toThrow();
  });

  test('strict equality === is rejected at parse time', () => {
    expect(() => evalExpr('auth.uid === "x"', baseCtx)).toThrow();
  });

  test('array literal evaluates to a JS array', () => {
    expect(evalExpr("['a', 'b']", baseCtx)).toEqual(['a', 'b']);
    expect(evalExpr('[]', baseCtx)).toEqual([]);
    expect(evalExpr('[1, 2, 3]', baseCtx)).toEqual([1, 2, 3]);
  });

  test('newData.hasChildren([...]) enforces all-keys-present through the grammar', () => {
    const withBody = { ...baseCtx, newData: new DataSnapshot({ title: 't', body: 'b' }) };
    expect(evalExpr("newData.hasChildren(['title', 'body'])", withBody)).toBe(true);

    const missingBody = { ...baseCtx, newData: new DataSnapshot({ title: 't' }) };
    expect(evalExpr("newData.hasChildren(['title', 'body'])", missingBody)).toBe(false);
  });

  describe('scientific notation evaluation', () => {
    test('evaluates scientific notation comparisons correctly', () => {
      const under1k = { ...baseCtx, data: new DataSnapshot(500) };
      const over1k = { ...baseCtx, data: new DataSnapshot(1500) };
      expect(evalExpr('data.val() < 1e3', under1k)).toBe(true);
      expect(evalExpr('data.val() < 1e3', over1k)).toBe(false);
    });

    test('evaluates scientific notation with decimals and negative exponents', () => {
      const smallVal = { ...baseCtx, data: new DataSnapshot(0.015) };
      expect(evalExpr('data.val() == 1.5e-2', smallVal)).toBe(true);
    });

    test('preserves subtraction precedence with scientific notation', () => {
      const fiveHundred = { ...baseCtx, data: new DataSnapshot(500) };
      expect(evalExpr('data.val() == 1e3 - 500', fiveHundred)).toBe(true);
    });
  });

  describe('single-quoted string escape resolution', () => {
    test('resolves newline and tab escapes', () => {
      const newlineData = { ...baseCtx, data: new DataSnapshot('hello\nworld') };
      expect(evalExpr("data.val() == 'hello\\nworld'", newlineData)).toBe(true);

      const tabData = { ...baseCtx, data: new DataSnapshot('col1\tcol2') };
      expect(evalExpr("data.val() == 'col1\\tcol2'", tabData)).toBe(true);
    });

    test('resolves escaped single quotes and backslashes', () => {
      const apostropheData = { ...baseCtx, data: new DataSnapshot("it's a test") };
      expect(evalExpr("data.val() == 'it\\'s a test'", apostropheData)).toBe(true);

      const slashData = { ...baseCtx, data: new DataSnapshot('a\\b') };
      expect(evalExpr("data.val() == 'a\\\\b'", slashData)).toBe(true);
    });

    test('resolves carriage return and double quotes', () => {
      const crData = { ...baseCtx, data: new DataSnapshot('line1\r\nline2') };
      expect(evalExpr("data.val() == 'line1\\r\\nline2'", crData)).toBe(true);

      const quoteData = { ...baseCtx, data: new DataSnapshot('he said "hi"') };
      expect(evalExpr("data.val() == 'he said \\\"hi\\\"'", quoteData)).toBe(true);
    });

    test('single-quoted and double-quoted string literals evaluate to identical values', () => {
      expect(evalExpr("'a\\nb\\tc'", baseCtx)).toBe(evalExpr('"a\\nb\\tc"', baseCtx));
    });

    test('preserves unrecognized escape sequences safely without throwing', () => {
      const unrecognized = { ...baseCtx, data: new DataSnapshot('\\z') };
      expect(evalExpr("data.val() == '\\z'", unrecognized)).toBe(true);
    });
  });
});
