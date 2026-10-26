/**
 * CS-1 (#1247): a key named `__proto__` is an ordinary RTDB key. Production
 * stores a write at `/path/__proto__` and runs its `$k` `.validate` (capture
 * rules-rtdb-r52-prototype-named-keys), so the simulated trees, before and
 * after the write, keep the key as an own property.
 */
import { describe, expect, test } from 'bun:test';
import { rtdbRules, type RtdbCase } from '../../../../src/rules/index.js';

const numbersOnly = rtdbRules({
  rules: { a: { '.read': true, '.write': true, $k: { '.validate': 'newData.isNumber()' } } },
});

function decide(c: Omit<RtdbCase, 'expectation'>): string {
  return numbersOnly.simulate([{ expectation: 'ALLOW', ...c }]).cases[0]!.decision;
}

describe('a key named __proto__ in the simulated trees', () => {
  test('a write at /a/__proto__ runs its $k .validate', () => {
    expect(decide({ operation: 'write', path: '/a/__proto__', newData: 'x' })).toBe('DENY');
    expect(decide({ operation: 'write', path: '/a/__proto__', newData: 1 })).toBe('ALLOW');
  });

  test('an update key __proto__ is a written path, and its .validate runs', () => {
    // The SDK's update() sends the patch object as given, so an own
    // `__proto__` key reaches the database as a path.
    const patch = JSON.parse('{"__proto__":"x"}') as Record<string, unknown>;
    expect(decide({ operation: 'update', path: '/a', newData: patch })).toBe('DENY');
    const nested = JSON.parse('{"__proto__/n":1, "b":"y"}') as Record<string, unknown>;
    expect(decide({ operation: 'update', path: '/a', newData: nested })).toBe('DENY');
  });

  test('a write case listing a __proto__ update path validates it', () => {
    expect(decide({
      operation: 'write',
      path: '/a/__proto__',
      newData: 'x',
      updates: [{ path: '/a/__proto__', value: 'x' }],
    })).toBe('DENY');
  });

  test('an increment at /a/__proto__ starts from zero, not from the object prototype', () => {
    const rs = rtdbRules({ rules: { a: { $k: { '.write': true, '.validate': 'newData.val() == 1' } } } });
    const [result] = rs.simulate([
      { expectation: 'ALLOW', operation: 'write', path: '/a/__proto__', newData: { '.sv': { increment: 1 } } },
    ]).cases;
    expect(result!.decision).toBe('ALLOW');
  });

  test('stored data under __proto__ reads as the stored value', () => {
    const rs = rtdbRules({ rules: { a: { $k: { '.read': "data.val() == 'stored'" } } } });
    const data = JSON.parse('{"a":{"__proto__":"stored"}}') as Record<string, unknown>;
    const [result] = rs.simulate([{ expectation: 'ALLOW', operation: 'read', path: '/a/__proto__', data }]).cases;
    expect(result!.decision).toBe('ALLOW');
  });

  test('a set value carrying an own __proto__ key is written without it, as the SDK sends it', () => {
    // The SDK serializes a set() value through `ChildrenNode.val()`, which
    // assigns each child (`obj[key] = childNode.val(...)`), so an own
    // `__proto__` key is dropped before the write leaves the client. The
    // r52 capture's object case is allowed in production.
    const value = JSON.parse('{"__proto__":"x"}') as Record<string, unknown>;
    expect(decide({ operation: 'write', path: '/a', newData: value })).toBe('ALLOW');
  });
});
