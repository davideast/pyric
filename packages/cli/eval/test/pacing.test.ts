/**
 * Pacing decides how fast the eval spends metered accounts, so its two rules
 * are pinned: one process per CLI at a time with a minimum gap, and a budget
 * that stops a CLI once the window is spent. Throttle detection is pinned
 * against the signals the runner documents.
 */
import { describe, expect, test } from 'bun:test';
import { BUDGET_WINDOW_MS, isThrottled, Pacer } from '../pacing.js';

/** A clock the test advances by hand, so pacing is exercised without waiting. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('throttle detection', () => {
  test('a rate-limit exit code is throttled', () => {
    expect(isThrottled(429, '')).toBe(true);
  });

  test('the documented stderr signals are throttled', () => {
    expect(isThrottled(1, 'Error: rate limit exceeded, retry after 30s')).toBe(true);
    expect(isThrottled(1, 'HTTP 429 Too Many Requests')).toBe(true);
    expect(isThrottled(1, 'quota exhausted for this account')).toBe(true);
    expect(isThrottled(1, 'the model is overloaded')).toBe(true);
  });

  test('an ordinary failure is not throttled', () => {
    expect(isThrottled(1, 'SyntaxError: unexpected token')).toBe(false);
    expect(isThrottled(0, '')).toBe(false);
    expect(isThrottled(137, 'killed')).toBe(false);
  });
});

describe('pacing', () => {
  test('one CLI runs one process at a time', async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ minGapMs: 0, budgetPerWindow: 10, now: clock.now, sleep: clock.sleep });
    const order: string[] = [];
    const work = (label: string) => async () => {
      order.push(`start ${label}`);
      await Promise.resolve();
      order.push(`end ${label}`);
    };

    await Promise.all([pacer.run('claude', work('a')), pacer.run('claude', work('b'))]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  test('two CLIs are not serialized against each other', async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ minGapMs: 0, budgetPerWindow: 10, now: clock.now, sleep: clock.sleep });
    const started: string[] = [];
    const work = (label: string) => async () => {
      started.push(label);
      await Promise.resolve();
    };

    await Promise.all([pacer.run('claude', work('claude')), pacer.run('codex', work('codex'))]);
    expect(started.sort()).toEqual(['claude', 'codex']);
  });

  test('the minimum gap is waited out between spawns of one CLI', async () => {
    const clock = fakeClock();
    const pacer = new Pacer({
      minGapMs: 5_000,
      budgetPerWindow: 10,
      now: clock.now,
      sleep: clock.sleep,
    });
    const spawnedAt: number[] = [];
    const work = async () => {
      spawnedAt.push(clock.now());
    };

    await pacer.run('claude', work);
    await pacer.run('claude', work);
    expect(spawnedAt[1] as number).toBeGreaterThanOrEqual((spawnedAt[0] as number) + 5_000);
  });

  test('a CLI stops having budget once the window is spent, and recovers after it', async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ minGapMs: 0, budgetPerWindow: 2, now: clock.now, sleep: clock.sleep });
    const work = async () => undefined;

    expect(pacer.hasBudget('claude')).toBe(true);
    await pacer.run('claude', work);
    await pacer.run('claude', work);
    expect(pacer.hasBudget('claude')).toBe(false);
    expect(pacer.hasBudget('codex')).toBe(true);

    clock.advance(BUDGET_WINDOW_MS);
    expect(pacer.hasBudget('claude')).toBe(true);
  });

  test('a failed run does not wedge the CLI', async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ minGapMs: 0, budgetPerWindow: 10, now: clock.now, sleep: clock.sleep });
    await expect(
      pacer.run('claude', async () => {
        throw new Error('crashed');
      }),
    ).rejects.toThrow('crashed');
    await expect(pacer.run('claude', async () => 'ok')).resolves.toBe('ok');
  });
});
