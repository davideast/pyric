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
