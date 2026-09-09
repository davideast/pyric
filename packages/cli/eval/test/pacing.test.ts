/**
 * Pacing decides how fast the eval spends metered accounts, so its two rules
 * are pinned: one process per CLI at a time with a minimum gap, and a budget
 * that stops a CLI once the window is spent. Throttle detection is pinned
 * against the signals the runner documents.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUDGET_WINDOW_MS, LOCK_STALE_MS, isThrottled, Pacer } from '../pacing.js';

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

/** The child script the contention test runs as its own operating-system process. */
const CONTENDER = join(import.meta.dirname, 'pacing-contender.ts');

/**
 * One contender process, resolving to the number of reservations it won. Two
 * pacer instances inside one process share a JavaScript thread and cannot show
 * that the lock works, so the contention test spawns real processes.
 */
function contend(ledgerRoot: string, attempts: number, budget: number): Promise<number> {
  return new Promise((resolveCount, rejectRun) => {
    const child = spawn('bun', [CONTENDER, ledgerRoot, 'claude', String(attempts), String(budget)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectRun(new Error(`contender exited ${code}`));
        return;
      }
      resolveCount(Number(stdout.trim()));
    });
  });
}

describe('the quota ledger is shared across pacer instances', () => {
  test('two pacer instances over one ledger share the budget', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const clock = fakeClock();
    const options = {
      minGapMs: 0,
      budgetPerWindow: 2,
      now: clock.now,
      sleep: clock.sleep,
      ledgerRoot,
      noWait: true,
    };
    const first = new Pacer(options);
    const second = new Pacer(options);

    expect(await first.reserveBudget('claude')).toBe('ready');
    expect(await second.reserveBudget('claude')).toBe('ready');
    // The budget is spent: neither instance has private room left, because both
    // read and wrote the same ledger file.
    expect(await first.reserveBudget('claude')).toBe('throttled');
  });

  test('a full ledger makes the second pacer wait until the oldest entry ages out', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const clock = fakeClock();
    const pacer = new Pacer({
      minGapMs: 0,
      budgetPerWindow: 1,
      now: clock.now,
      sleep: clock.sleep,
      ledgerRoot,
    });

    expect(await pacer.reserveBudget('claude')).toBe('ready');
    // The ledger is full. Without --no-wait, this call waits for the oldest
    // entry to age out of the window rather than reporting throttled. The
    // injected sleep advances the fake clock instead of really waiting.
    expect(await pacer.reserveBudget('claude')).toBe('ready');
  });

  test('--no-wait records throttled instead of waiting', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const clock = fakeClock();
    const pacer = new Pacer({
      minGapMs: 0,
      budgetPerWindow: 1,
      now: clock.now,
      sleep: clock.sleep,
      ledgerRoot,
      noWait: true,
    });

    expect(await pacer.reserveBudget('claude')).toBe('ready');
    expect(await pacer.reserveBudget('claude')).toBe('throttled');
  });

  test('two contending processes spend one budget exactly once between them', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const budget = 20;
    // Each process asks for the whole budget, so without mutual exclusion the
    // two would read the same ledger and win 40 reservations between them.
    const [first, second] = await Promise.all([
      contend(ledgerRoot, budget, budget),
      contend(ledgerRoot, budget, budget),
    ]);

    expect(first + second).toBe(budget);
    const ledger = JSON.parse(readFileSync(join(ledgerRoot, 'claude.json'), 'utf8')) as {
      timestamps: number[];
    };
    expect(ledger.timestamps).toHaveLength(budget);
  }, 60_000);

  test('a lock a dead process left behind is broken rather than waited on forever', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    // A directory older than the staleness limit is what a killed runner leaves.
    const stale = join(ledgerRoot, 'claude.lock');
    mkdirSync(stale, { recursive: true });
    const longAgo = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(stale, longAgo, longAgo);

    const pacer = new Pacer({ minGapMs: 0, budgetPerWindow: 1, ledgerRoot, noWait: true });
    expect(await pacer.reserveBudget('claude')).toBe('ready');
  }, 30_000);

  test('an entry one millisecond short of the window still counts against the budget', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const clock = fakeClock();
    const pacer = new Pacer({
      minGapMs: 0,
      budgetPerWindow: 1,
      now: clock.now,
      sleep: clock.sleep,
      ledgerRoot,
      noWait: true,
    });

    expect(await pacer.reserveBudget('claude')).toBe('ready');
    clock.advance(BUDGET_WINDOW_MS - 1);
    expect(await pacer.reserveBudget('claude')).toBe('throttled');
  });

  test('an entry exactly one window old has aged out and frees its room', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const clock = fakeClock();
    const pacer = new Pacer({
      minGapMs: 0,
      budgetPerWindow: 1,
      now: clock.now,
      sleep: clock.sleep,
      ledgerRoot,
      noWait: true,
    });

    expect(await pacer.reserveBudget('claude')).toBe('ready');
    clock.advance(BUDGET_WINDOW_MS);
    expect(await pacer.reserveBudget('claude')).toBe('ready');
  });

  test('a full ledger for one CLI does not throttle another', async () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'pyric-pacing-'));
    const clock = fakeClock();
    const pacer = new Pacer({
      minGapMs: 0,
      budgetPerWindow: 1,
      now: clock.now,
      sleep: clock.sleep,
      ledgerRoot,
      noWait: true,
    });

    expect(await pacer.reserveBudget('claude')).toBe('ready');
    expect(await pacer.reserveBudget('claude')).toBe('throttled');
    expect(await pacer.reserveBudget('codex')).toBe('ready');
  });
});
