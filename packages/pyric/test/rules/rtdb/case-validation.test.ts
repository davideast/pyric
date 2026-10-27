/**
 * Cases the client SDK would refuse are not evaluated (#1247 CS-4, CS-5,
 * CS-6). Each is UNSUPPORTED with the SDK's error text where a capture
 * records it.
 */
import { describe, expect, test } from 'bun:test';
import { rtdbRules, type RtdbCase } from '../../../src/rules/index.js';

const open = rtdbRules({
  rules: {
    '.read': true,
    '.write': true,
    a: { '.validate': 'newData.isNumber()' },
    users: { $uid: { '.write': 'auth.uid == $uid' } },
  },
});

function run(c: Omit<RtdbCase, 'expectation'>, ruleset = open) {
  return ruleset.simulate([{ expectation: 'ALLOW', ...c }]).cases[0]!;
}

const PATH_SUFFIX = 'Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"';
const KEY_SUFFIX = 'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';

describe('CS-6: a case path the SDK refuses', () => {
  // Capture rtdb-modular-reference-shape-url, referenceValidation.invalidRefPaths.
  for (const key of ['a.b', 'a#', 'a[0]', 'a]', '$uid']) {
    test(`/users/${key} is UNSUPPORTED with the SDK's text`, () => {
      const result = run({ operation: 'write', path: `/users/${key}`, newData: 1, auth: key });
      expect(result.decision).toBe('UNSUPPORTED');
      expect(result.reason).toBe(`child failed: path argument was an invalid path = "/users/${key}". ${PATH_SUFFIX}`);
    });
  }

  test('a read of a refused path is UNSUPPORTED too', () => {
    expect(run({ operation: 'read', path: '/a.b' }).decision).toBe('UNSUPPORTED');
  });

  test('an update key holding a refused character is UNSUPPORTED', () => {
    const result = run({ operation: 'update', path: '/users', newData: { 'a.b': 1 } });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toBe(`update failed: values argument contains an invalid key (a.b) in path /a.b. ${KEY_SUFFIX}`);
  });

  test("an 'updates' path holding a refused character is UNSUPPORTED", () => {
    const result = run({ operation: 'write', path: '/a', newData: 1, updates: [{ path: '/a', value: 1 }, { path: '/b$', value: 1 }] });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toContain('invalid key (b$)');
  });

  test('ordinary keys, a nested path and /.info still evaluate', () => {
    expect(run({ operation: 'write', path: '/users/alice', newData: 1, auth: 'alice' }).decision).toBe('ALLOW');
    expect(run({ operation: 'update', path: '/users', newData: { 'alice/name': 'x' }, auth: 'alice' }).decision).toBe('ALLOW');
    expect(run({ operation: 'read', path: '/.info/connected' }).decision).not.toBe('UNSUPPORTED');
  });
});

describe('CS-5: overlapping or duplicate update paths', () => {
  // Capture rtdb-modular-write-return-validation, behavior.overlapping.
  test('an ancestor and its descendant are UNSUPPORTED with the SDK text', () => {
    const result = run({ operation: 'update', path: '/', newData: { a: { b: 1 }, 'a/b': 2 } });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toBe('update failed: values argument contains a path /a that is ancestor of another path /a/b');
  });

  test('two keys naming one path after normalization are UNSUPPORTED', () => {
    const result = run({ operation: 'update', path: '/', newData: { b: 1, '/b/': 2 } });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toContain('contains a path /b that is ancestor of another path /b');
  });

  test("overlapping 'updates' entries are UNSUPPORTED", () => {
    for (const updates of [
      [{ path: '/a', value: 1 }, { path: '/a', value: 1 }],
      [{ path: '/a', value: 1 }, { path: '/a/b', value: 1 }],
    ]) {
      expect(run({ operation: 'write', path: '/a', updates }).decision).toBe('UNSUPPORTED');
    }
  });

  test('sibling paths still evaluate', () => {
    expect(run({ operation: 'update', path: '/', newData: { a: 1, ab: 2, 'c/d': 3 } }).decision).toBe('ALLOW');
  });
});

describe('CS-7: a read case whose query the SDK refuses', () => {
  test('is UNSUPPORTED with the SDK text', () => {
    const result = run({ operation: 'read', path: '/a', query: { orderByChild: '$key' } });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toBe('orderByChild: "$key" is invalid.  Use orderByKey() instead.');
    expect(run({ operation: 'read', path: '/a', query: { startAt: true } }).decision).toBe('UNSUPPORTED');
  });
});

describe("CS-4: a write case whose 'updates' disagree with it", () => {
  // case-types.ts: newData is the case's proposed value; updates lists every
  // path written together so the case path's rules see the shared projection.
  test("a path none of the 'updates' writes is UNSUPPORTED", () => {
    const result = run({ operation: 'write', path: '/a', newData: 'str', updates: [{ path: '/b', value: 1 }] });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toContain("'updates' must list the case's path '/a'");
  });

  test("newData that differs from the value 'updates' writes at the path is UNSUPPORTED", () => {
    const result = run({ operation: 'write', path: '/a', newData: 'str', updates: [{ path: '/a', value: 1 }] });
    expect(result.decision).toBe('UNSUPPORTED');
    expect(result.reason).toContain("newData differs from the value 'updates' writes at '/a'");
  });

  test("matching newData, or none, evaluates the value 'updates' writes", () => {
    const updates = [{ path: '/a/', value: 'str' }, { path: '/b', value: 1 }];
    expect(run({ operation: 'write', path: '/a', newData: 'str', updates }).decision).toBe('DENY');
    expect(run({ operation: 'write', path: '/a', updates }).decision).toBe('DENY');
    expect(run({ operation: 'validate', path: '/a', updates: [{ path: '/a', value: 2 }] }).decision).toBe('ALLOW');
  });
});
