/**
 * A deployed Realtime Database ruleset parses each rule expression at most
 * once for evaluation, not once per rules-checked request.
 *
 * Counts calls to the expression matcher the RTDB rules engine uses, after
 * the ruleset compiles, across sandbox writes, multi-path updates and reads,
 * and across repeated simulate() calls on one compiled ruleset.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const enginePath = new URL(
  '../rtdb/expression-engine.js',
  import.meta.resolve('pyric/rules/internal'),
).pathname;
const engine = await import(enginePath);
const matchRtdbExpression = engine.matchRtdbExpression as (raw: string) => unknown;
let parses = 0;
mock.module(enginePath, () => ({
  ...engine,
  matchRtdbExpression: (raw: string) => {
    parses++;
    return matchRtdbExpression(raw);
  },
}));

const { initializeSandbox } = await import('pyric/sandbox');
const { getDatabase, ref, set, update, get, sandbox } = await import('pyric/database');
const { rtdbRules } = await import('pyric/rules');

// Three rule expressions a write to /rooms/$room/{score,title} evaluates.
const RULES = {
  rules: {
    rooms: {
      $room: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        score: { '.validate': 'newData.isNumber() && newData.val() >= 0' },
        title: { '.validate': 'newData.isString()' },
      },
    },
  },
};

beforeEach(() => {
  parses = 0;
});

describe('RTDB rules parsing', () => {
  test('50 writes after setRules parse each evaluated rule once', async () => {
    const box = initializeSandbox();
    sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), RULES);
    const db = getDatabase(box.withAuth({ uid: 'u' }));
    parses = 0;
    await set(ref(db, 'rooms/r1/score'), 0);
    const afterFirst = parses;
    expect(afterFirst).toBeLessThanOrEqual(2);
    for (let i = 1; i < 50; i++) await set(ref(db, 'rooms/r1/score'), i);
    expect(parses).toBe(afterFirst);
  });

  test('multi-path updates and reads reuse the same parse', async () => {
    const box = initializeSandbox();
    sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), RULES);
    const db = getDatabase(box.withAuth({ uid: 'u' }));
    parses = 0;
    await update(ref(db, 'rooms'), { 'r1/score': 1, 'r1/title': 'a', 'r2/score': 2 });
    await get(ref(db, 'rooms/r1'));
    const afterFirst = parses;
    for (let i = 0; i < 20; i++) {
      await update(ref(db, 'rooms'), { 'r1/score': i, 'r1/title': `t${i}`, 'r2/score': i });
      await get(ref(db, 'rooms/r1'));
    }
    expect(parses).toBe(afterFirst);
  });

  test('a later setRules call parses the new ruleset for the next request', async () => {
    const box = initializeSandbox();
    const admin = getDatabase(box.withAuth({ uid: 'admin' }));
    const db = getDatabase(box.withAuth({ uid: 'u' }));
    sandbox.setRules(admin, RULES);
    await set(ref(db, 'rooms/r1/score'), 1);
    sandbox.setRules(admin, { rules: { rooms: { $room: { '.write': 'false' } } } });
    parses = 0;
    await expect(set(ref(db, 'rooms/r1/score'), 2)).rejects.toThrow();
    const afterFirst = parses;
    expect(afterFirst).toBe(1);
    await expect(set(ref(db, 'rooms/r1/score'), 3)).rejects.toThrow();
    expect(parses).toBe(afterFirst);
  });

  test('a compiled ruleset does not parse again when it simulates', () => {
    const ruleset = rtdbRules(RULES);
    const cases = [{
      expectation: 'ALLOW' as const,
      operation: 'write' as const,
      path: '/rooms/r1/score',
      auth: 'alice',
      data: {},
      newData: 3,
    }];
    ruleset.simulate(cases);
    parses = 0;
    for (let i = 0; i < 3; i++) {
      expect(ruleset.simulate(cases).cases[0].decision).toBe('ALLOW');
    }
    expect(parses).toBe(0);
  });
});
