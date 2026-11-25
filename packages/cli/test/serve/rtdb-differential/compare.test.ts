import { describe, expect, test } from 'bun:test';
import { firstMismatch, normalize } from './compare.js';
import type { Trace } from './interpreter.js';

/** A push key: `-`, then 19 key characters, the first eight from the mint time. */
function pushKey(time: string, suffix: string): string {
  return `-${time}${suffix}`.padEnd(20, 'x');
}

function traceOf(pushed: string[]): Trace {
  return {
    seed: 1,
    steps: pushed.map((key) => ({ ok: key })),
    events: { L0: [{ value: Object.fromEntries(pushed.map((key, index) => [key, index])) }] },
    data: [Object.fromEntries(pushed.map((key, index) => [key, { n: index }]))],
    anonymous: [],
    pushed,
  };
}

describe('push-key placeholders', () => {
  test('are named in the order the sequence minted the keys, even when a later key sorts first', () => {
    // The host clock stepped back between the two pushes, so the second key
    // carries an earlier time and sorts before the first.
    const first = pushKey('NzzzzzzA', 'aaaa');
    const second = pushKey('NaaaaaaA', 'bbbb');
    expect(second < first).toBe(true);
    expect(normalize(traceOf([first, second])).steps).toEqual([{ ok: '<push0>' }, { ok: '<push1>' }]);
  });

  test('let planes agree when only one of them minted across a clock step back', () => {
    const steady = traceOf([pushKey('NaaaaaaA', 'aaaa'), pushKey('NaaaaaaB', 'bbbb')]);
    const steppedBack = traceOf([pushKey('NzzzzzzA', 'cccc'), pushKey('NaaaaaaA', 'dddd')]);
    expect(firstMismatch({ sandbox: normalize(steady), node: normalize(steppedBack) })).toBeNull();
  });
});

describe('anonymous uid placeholders', () => {
  test('keep first-minted indices when signInAnonymously returns an existing anonymous session', () => {
    const uid0 = 'anonymous-f0000000-0000-4000-8000-000000000000';
    const uid1 = 'anonymous-10000000-0000-4000-8000-000000000001';
    const trace: Trace = {
      seed: 658002,
      steps: [{ ok: uid0 }, { ok: uid1 }, { ok: uid1 }],
      events: {
        'L0 child_added db1 /users': [
          { key: uid1, value: 94, previous: null },
          { key: uid0, value: 5, previous: uid1 },
        ],
      },
      data: [{ users: { [uid0]: 5, [uid1]: 94 } }],
      anonymous: [uid0, uid1, uid1],
      pushed: [],
    };
    const normalized = normalize(trace);
    expect(normalized.steps).toEqual([
      { ok: '<anonymous0>' },
      { ok: '<anonymous1>' },
      { ok: '<anonymous1>' },
    ]);
    expect(normalized.events['L0 child_added db1 /users']).toEqual([
      { key: '<anonymous1>', value: 94, previous: null },
      { key: '<anonymous0>', value: 5, previous: '<anonymous1>' },
    ]);
  });
});
