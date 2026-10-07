import { describe, expect, test } from 'bun:test';
import { all, authenticated, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario, type StdlibCase } from './harness.js';

const { counters, lifecycle } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/stats/$id': {
      // .validate does not run on a delete, so the .write refuses one.
      write: all(authenticated(), lifecycle.noDelete()),
      children: {
        '/likes': { validate: counters.changedBy(-1, 1) },
        '/moves': { validate: counters.incrementedBy(1, { start: 0 }) },
        '/best': { validate: counters.improved('up') },
        '/fastest': { validate: counters.improved('down') },
      },
    },
    '/scores/$id': {
      write: all(authenticated(), lifecycle.noDelete()),
      validate: counters.oneIncremented(['host', 'guest'], 1, { start: 0 }),
    },
  },
  cases: [],
};

const set = (field: string, before: unknown, after: unknown, expectation: 'ALLOW' | 'DENY', description: string): StdlibCase => ({
  description,
  expectation,
  operation: 'write',
  path: `/stats/s1/${field}`,
  auth: 'alice',
  ...(before === undefined ? {} : { data: { stats: { s1: { [field]: before } } } }),
  newData: after,
});
const score = (before: unknown, after: Record<string, unknown>, expectation: 'ALLOW' | 'DENY', description: string): StdlibCase => ({
  description,
  expectation,
  operation: 'write',
  path: '/scores/g1',
  auth: 'alice',
  ...(before === undefined ? {} : { data: { scores: { g1: before } } }),
  newData: after,
});

scenario.cases.push(
  set('likes', 5, 6, 'ALLOW', 'a like adds one'),
  set('likes', 5, 4, 'ALLOW', 'an unlike removes one'),
  set('likes', 5, 5, 'ALLOW', 'a like count written unchanged'),
  set('likes', 5, 7, 'DENY', 'a like count that jumps by two'),
  set('likes', 5, '6', 'DENY', 'a like count written as a string'),
  set('moves', undefined, 0, 'ALLOW', 'a move count created at its start'),
  set('moves', undefined, 1, 'DENY', 'a move count created past its start'),
  set('moves', 3, 4, 'ALLOW', 'a move count that grows by one'),
  set('moves', 3, 3, 'DENY', 'a move count written unchanged'),
  set('moves', 3, 5, 'DENY', 'a move count that grows by two'),
  set('best', undefined, 3, 'ALLOW', 'a first best score'),
  set('best', 10, 12, 'ALLOW', 'a better best score'),
  set('best', 10, 10, 'DENY', 'an equal best score'),
  set('best', 10, 9, 'DENY', 'a worse best score'),
  set('fastest', 10, 9, 'ALLOW', 'a faster time'),
  set('fastest', 10, 11, 'DENY', 'a slower time'),
  score(undefined, { host: 0, guest: 0 }, 'ALLOW', 'a score created at 0 to 0'),
  score(undefined, { host: 1, guest: 0 }, 'DENY', 'a score created at 1 to 0'),
  score({ host: 2, guest: 1 }, { host: 3, guest: 1 }, 'ALLOW', 'a goal for the host'),
  score({ host: 2, guest: 1 }, { host: 2, guest: 2 }, 'ALLOW', 'a goal for the guest'),
  score({ host: 2, guest: 1 }, { host: 3, guest: 2 }, 'DENY', 'a goal for both sides at once'),
  score({ host: 2, guest: 1 }, { host: 4, guest: 1 }, 'DENY', 'two goals for one side at once'),
  score({ host: 2, guest: 1 }, { host: 2, guest: 1 }, 'DENY', 'a score written unchanged'),
);

describe('rtdbStdlib.counters', () => {
  test('incrementedBy compiles with and without a start value', () => {
    expect(counters.incrementedBy(1)).toBe('data.exists() && newData.val() == data.val() + 1');
    expect(counters.incrementedBy(-2, { start: 10 })).toBe(
      '(!data.exists() && newData.val() == 10) || (data.exists() && newData.val() == data.val() + -2)',
    );
  });

  test('improved compares with the stored value', () => {
    expect(counters.improved('up')).toBe('newData.isNumber() && (!data.exists() || newData.val() > data.val())');
    expect(counters.improved('down')).toBe('newData.isNumber() && (!data.exists() || newData.val() < data.val())');
  });

  test('builders refuse arguments they cannot compile', () => {
    expect(() => counters.changedBy(2, 1)).toThrow();
    expect(() => counters.oneIncremented([], 1)).toThrow();
    expect(() => counters.incrementedBy(Number.NaN)).toThrow();
  });

  runScenario(scenario);
});
