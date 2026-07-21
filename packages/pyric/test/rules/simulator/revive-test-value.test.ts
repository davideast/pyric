import { describe, expect, test } from 'bun:test';
import { reviveTestValue } from '../../../src/rules/simulator/revive-test-value.js';
import { RulesFloat } from '../../../src/rules/simulator/wrappers/float.js';

describe('reviveTestValue', () => {
  test('recovers fractional JSON numbers as Rules floats recursively', () => {
    const revived = reviveTestValue({ price: 1.5, nested: [2, 2.5] }) as {
      price: unknown;
      nested: unknown[];
    };

    expect(revived.price).toBeInstanceOf(RulesFloat);
    expect(revived.nested[0]).toBe(2);
    expect(revived.nested[1]).toBeInstanceOf(RulesFloat);
  });

  test('preserves an explicitly tagged integral double', () => {
    const revived = reviveTestValue({ __type: 'float', value: 2 });

    expect(revived).toBeInstanceOf(RulesFloat);
  });

  test('does not traverse class instances', () => {
    const instance = new Date(0);

    expect(reviveTestValue(instance)).toBe(instance);
  });
});
