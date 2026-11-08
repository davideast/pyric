/**
 * The session byte budget (`session-budget.ts`): every charge is at least the
 * UTF-8 bytes its token adds to the value's JSON, as the host measures it.
 */
import { describe, expect, test } from 'bun:test';
import {
  chargeContainer,
  chargeJson,
  chargeScalar,
  chargeString,
  jsonByteLength,
  type SessionBudget,
} from '../src/session-budget.js';

function spent(charge: (budget: SessionBudget) => boolean): number {
  const budget: SessionBudget = { left: 1_000_000 };
  charge(budget);
  return 1_000_000 - budget.left;
}

describe('jsonByteLength', () => {
  test('counts UTF-8 bytes of the JSON, quotes and escapes included', () => {
    expect(jsonByteLength('abc')).toBe(5);
    expect(jsonByteLength('\u6f22')).toBe(5);
    expect(jsonByteLength('\u{1F600}')).toBe(6);
    expect(jsonByteLength('a"b\n')).toBe(8);
    expect(jsonByteLength(undefined)).toBe(0);
  });
});

describe('charges', () => {
  test('a string is charged its quoted UTF-8 length plus a separator', () => {
    expect(spent((b) => chargeString(b, '\u6f22'.repeat(10)))).toBe(30 + 2 + 1);
  });

  test('a number is charged at least its printed length plus a separator', () => {
    expect(spent((b) => chargeScalar(b, 1))).toBe(8);
    expect(spent((b) => chargeScalar(b, -1.2345678901234567e-300))).toBe(String(-1.2345678901234567e-300).length + 1);
    expect(spent((b) => chargeScalar(b, null))).toBe(8);
  });

  test('a container and a serialized value are charged', () => {
    expect(spent((b) => chargeContainer(b))).toBe(3);
    expect(spent((b) => chargeJson(b, { seconds: 1, nanoseconds: 2 }))).toBe(JSON.stringify({ seconds: 1, nanoseconds: 2 }).length + 1);
  });

  test('a charge reports whether the budget still holds', () => {
    const budget: SessionBudget = { left: 6 };
    expect(chargeString(budget, 'ab')).toBe(true);
    expect(chargeString(budget, 'c')).toBe(false);
    expect(budget.left).toBeLessThan(0);
  });
});
