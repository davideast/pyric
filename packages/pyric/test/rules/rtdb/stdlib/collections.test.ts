import { describe, expect, test } from 'bun:test';
import { all, authenticated, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { collections } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/tables/$tableId': {
      write: authenticated(),
      children: {
      // slotKey and keyIn check the key, not the value. A .validate that never
      // reads its own new value constrains none (ruleset-lint.ts
      // hasEffectiveValidate; LD-4, #1247), so each ANDs in a value check.
        '/seats/$slot': { validate: all(collections.slotKey('$slot', 4), 'newData.isString()') },
        '/flags/$flag': { validate: all(collections.keyIn('$flag', ['red', 'blue']), 'newData.isBoolean()') },
      },
    },
  },
  cases: [],
};

scenario.cases.push(
  { description: 'a seat in the first slot', expectation: 'ALLOW', operation: 'write', path: '/tables/t1/seats/0', auth: 'alice', newData: 'alice' },
  { description: 'a seat in the last slot', expectation: 'ALLOW', operation: 'write', path: '/tables/t1/seats/3', auth: 'alice', newData: 'alice' },
  { description: 'a seat past the last slot', expectation: 'DENY', operation: 'write', path: '/tables/t1/seats/4', auth: 'alice', newData: 'alice' },
  { description: 'a seat with a key that is not a slot', expectation: 'DENY', operation: 'write', path: '/tables/t1/seats/front', auth: 'alice', newData: 'alice' },
  { description: 'a list of four seats', expectation: 'ALLOW', operation: 'write', path: '/tables/t1/seats', auth: 'alice', newData: ['a', 'b', 'c', 'd'] },
  { description: 'a list of five seats', expectation: 'DENY', operation: 'write', path: '/tables/t1/seats', auth: 'alice', newData: ['a', 'b', 'c', 'd', 'e'] },
  { description: 'a listed flag', expectation: 'ALLOW', operation: 'write', path: '/tables/t1/flags/red', auth: 'alice', newData: true },
  { description: 'a flag that is not listed', expectation: 'DENY', operation: 'write', path: '/tables/t1/flags/green', auth: 'alice', newData: true },
  { description: 'a seat in a slot holding a number', expectation: 'DENY', operation: 'write', path: '/tables/t1/seats/0', auth: 'alice', newData: 7 },
);

describe('rtdbStdlib.collections', () => {
  test('slotKey lists each slot key', () => {
    expect(collections.slotKey('$slot', 2)).toBe("$slot == '0' || $slot == '1'");
    expect(collections.keyIn('$k', ['a'])).toBe("$k == 'a'");
  });

  test('builders refuse arguments they cannot compile', () => {
    expect(() => collections.slotKey('$slot', 0)).toThrow();
    expect(() => collections.slotKey('slot', 2)).toThrow();
    expect(() => collections.keyIn('$k', [])).toThrow();
    expect(() => collections.keyIn('$k', [''])).toThrow(/field name/);
    expect(() => collections.keyIn('$k', ['a/b'])).toThrow(/field name/);
  });

  runScenario(scenario);
});

describe('slotKey max is bounded (LD-11)', () => {
  test('refuses 1e21 with a plain Error naming the limit', () => {
    expect(() => collections.slotKey('$s', 1e21)).toThrow(/max must be an integer from 1 to 1000/);
    expect(() => collections.slotKey('$s', 1e21)).not.toThrow(RangeError);
  });
});
