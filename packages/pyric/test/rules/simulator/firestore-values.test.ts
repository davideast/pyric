import { describe, expect, test } from 'bun:test';
import { reviveFirestoreNumbers } from '../../../src/rules/simulator/firestore-values.js';
import { RulesFloat } from '../../../src/rules/simulator/wrappers/float.js';

describe('reviveFirestoreNumbers', () => {
  test('restores non-integral JSON numbers as Firestore floats', () => {
    const revived = reviveFirestoreNumbers({ price: 1.5, count: 7 }) as {
      price: unknown;
      count: unknown;
    };

    expect(revived.price).toBeInstanceOf(RulesFloat);
    expect(revived.count).toBe(7);
  });

  test('recurses through arrays and plain objects', () => {
    const revived = reviveFirestoreNumbers({ values: [1, { nested: 2.5 }] }) as {
      values: [number, { nested: unknown }];
    };

    expect(revived.values[0]).toBe(1);
    expect(revived.values[1].nested).toBeInstanceOf(RulesFloat);
  });

  test('preserves an explicitly tagged integral double', () => {
    const revived = reviveFirestoreNumbers({ __type: 'float', value: 2 });

    expect(revived).toBeInstanceOf(RulesFloat);
  });

  test('does not traverse class instances', () => {
    const instance = new Date(0);

    expect(reviveFirestoreNumbers(instance)).toBe(instance);
  });
});
