/**
 * Pacing and throttle detection.
 *
 * Every CLI in the matrix is a metered account. The runner therefore holds one
 * process per CLI at a time, keeps a minimum gap between that CLI's spawns, and
 * stops spending a CLI once it has used its budget inside the current five-hour
 * window. A run that the provider rejected for rate limiting is recorded and not
 * retried, because a retry inside a limit window costs budget and returns the
 * same answer.
 *
 * The budget itself is shared across processes: two runner invocations on the
 * same subscription must not each believe they hold the full window. A ledger
 * file under `<tmpdir>/pyric-eval/pacing/<cli>.json` holds the timestamps of
 * every spawn recorded in the current window, one file per CLI, guarded by an
 * exclusive-create lock directory so two processes never read and write it at
 * once. `reserveBudget` is the entry point that consults and updates it: it
 * either records a timestamp and returns immediately, or, absent `--no-wait`,
 * waits for the oldest timestamp to age out of the window and tries again.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Length of the budget window every CLI is metered against. */
export const BUDGET_WINDOW_MS = 5 * 60 * 60 * 1000;

export interface PacingOptions {
  /** Smallest gap between two spawns of the same CLI. */
  minGapMs: number;
  /** Runs one CLI may spend inside one window. */
  budgetPerWindow: number;
  /** Injected clock, so tests do not wait. */
  now?: () => number;
  /** Injected sleep, so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Root directory holding one ledger file per CLI. Defaults to `PACING_ROOT`. */
  ledgerRoot?: string;
  /** When true, a full ledger reports `throttled` instead of waiting it out. */
  noWait?: boolean;
}

/** Default budget per CLI per five-hour window, before `--budget` overrides it. */
export const DEFAULT_BUDGET_PER_WINDOW = 120;

export const DEFAULT_PACING: PacingOptions = {
  minGapMs: 5_000,
  budgetPerWindow: DEFAULT_BUDGET_PER_WINDOW,
};

/** Where the shared per-CLI ledgers live: under the OS temp root, one file per CLI. */
export const PACING_ROOT = join(tmpdir(), 'pyric-eval', 'pacing');

function ledgerFile(root: string, cli: string): string {
  return join(root, `${cli}.json`);
}

function lockDir(root: string, cli: string): string {
  return join(root, `${cli}.lock`);
}

/**
 * How long a held lock may go untouched before another process breaks it. The
 * critical section is a read, a small JSON write and a directory removal, so
 * anything older than this is a process that died holding the lock. Without
 * this, one killed runner leaves a directory under the OS temp root that wedges
 * every later runner forever, which is the failure the unattended harness must
 * not have.
 */
export const LOCK_STALE_MS = 30_000;

/**
 * Age of an existing lock directory in real time, or null when it is already
 * gone. Real time rather than the injected clock: staleness is about how long
 * another operating-system process has actually been silent, which a test's
 * simulated budget clock says nothing about.
 */
function lockAgeMs(dir: string): number | null {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Acquire an exclusive lock on one CLI's ledger by creating a directory, which
 * is atomic on the filesystems this runs against. A process that loses the race
 * retries after a short sleep rather than failing, since the winner always
 * releases the lock quickly. A lock older than `LOCK_STALE_MS` belongs to a
 * process that died holding it and is broken so the ledger stays usable.
 */
async function acquireLock(
  root: string,
  cli: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  mkdirSync(root, { recursive: true });
  const dir = lockDir(root, cli);
  for (;;) {
    try {
      mkdirSync(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const age = lockAgeMs(dir);
      if (age !== null && age > LOCK_STALE_MS) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      await sleep(20);
    }
  }
}

function releaseLock(root: string, cli: string): void {
  rmSync(lockDir(root, cli), { recursive: true, force: true });
}

function readLedger(root: string, cli: string): number[] {
  const path = ledgerFile(root, cli);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { timestamps?: unknown };
    if (!Array.isArray(parsed.timestamps)) return [];
    return parsed.timestamps.filter((entry): entry is number => typeof entry === 'number');
  } catch {
    return [];
  }
}

function writeLedger(root: string, cli: string, timestamps: number[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(ledgerFile(root, cli), JSON.stringify({ timestamps }), 'utf8');
}

/** Timestamps still inside the window as of `now`. */
function pruneLedger(timestamps: number[], now: number): number[] {
  return timestamps.filter((entry) => now - entry < BUDGET_WINDOW_MS);
}

/** Whether one reservation attempt won room in the window, and the oldest entry seen. */
interface ReservationAttempt {
  ready: boolean;
  oldest: number | undefined;
}

/**
 * Run `mutate` with exclusive access to one CLI's ledger: read it pruned to the
 * current window, hand it to `mutate`, persist whatever `mutate` returns as the
 * new ledger, and release the lock. Returns `mutate`'s own result alongside.
 */
async function withLedger<T>(
  root: string,
  cli: string,
  now: number,
  sleep: (ms: number) => Promise<void>,
  mutate: (pruned: number[]) => { timestamps: number[]; result: T },
): Promise<T> {
  await acquireLock(root, cli, sleep);
  try {
    const pruned = pruneLedger(readLedger(root, cli), now);
    const { timestamps, result } = mutate(pruned);
    writeLedger(root, cli, timestamps);
    return result;
  } finally {
    releaseLock(root, cli);
  }
}

/**
 * Rate-limit signals, matched case insensitively against a process's stderr.
 * These are the phrases the three CLIs print when an account or an upstream
 * provider refuses the request for quota reasons rather than for a bad request.
 */
export const THROTTLE_PATTERNS: readonly RegExp[] = [
  /rate[ _-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /quota (exceeded|exhausted)/i,
  /usage limit/i,
  /overloaded/i,
  /insufficient[_ ]quota/i,
  /retry[- ]after/i,
];

/**
 * Exit codes that mean the CLI refused the request for quota reasons. Both CLIs
 * that document one use 429 directly, and the shell reports a signal-killed
 * process above 128, which is never a quota refusal.
 */
export const THROTTLE_EXIT_CODES: readonly number[] = [429];

/** Whether a finished process was refused for rate limiting. */
export function isThrottled(exitCode: number | null, stderr: string): boolean {
  if (exitCode !== null && THROTTLE_EXIT_CODES.includes(exitCode)) return true;
  return THROTTLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

interface CliMeter {
  lastSpawnAt: number;
  windowStartedAt: number;
  spentInWindow: number;
}

/** Serializes and meters spawns per CLI. One instance per runner invocation. */
export class Pacer {
  private readonly meters = new Map<string, CliMeter>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PacingOptions = DEFAULT_PACING) {
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Meter state for one CLI, created on first use. */
  private meterFor(cli: string): CliMeter {
    const existing = this.meters.get(cli);
    if (existing !== undefined) return existing;
    const created: CliMeter = {
      lastSpawnAt: Number.NEGATIVE_INFINITY,
      windowStartedAt: this.now(),
      spentInWindow: 0,
    };
    this.meters.set(cli, created);
    return created;
  }

  /** True once this CLI has spent its budget inside the current window. */
  hasBudget(cli: string): boolean {
    const meter = this.meterFor(cli);
    const elapsed = this.now() - meter.windowStartedAt;
    if (elapsed >= BUDGET_WINDOW_MS) {
      meter.windowStartedAt = this.now();
      meter.spentInWindow = 0;
    }
    return meter.spentInWindow < this.options.budgetPerWindow;
  }

  /**
   * Reserve one spawn of `cli` against the shared ledger. When the window has
   * room, a timestamp is recorded under lock and this resolves `'ready'`
   * immediately. When the window is full, this waits for the oldest recorded
   * timestamp to age out and retries, unless `options.noWait` is set, in which
   * case it resolves `'throttled'` on the first full ledger without waiting.
   *
   * This is the cross-process budget: it is consulted in addition to, not
   * instead of, `run`'s in-process minimum gap.
   */
  async reserveBudget(cli: string): Promise<'ready' | 'throttled'> {
    const root = this.options.ledgerRoot ?? PACING_ROOT;
    for (;;) {
      const outcome = await withLedger<ReservationAttempt>(
        root,
        cli,
        this.now(),
        this.sleep,
        (pruned) => {
          if (pruned.length < this.options.budgetPerWindow) {
            return { timestamps: [...pruned, this.now()], result: { ready: true, oldest: pruned[0] } };
          }
          return { timestamps: pruned, result: { ready: false, oldest: pruned[0] } };
        },
      );
      if (outcome.ready) return 'ready';
      if (this.options.noWait === true) return 'throttled';
      const oldest = outcome.oldest;
      const waitMs =
        oldest === undefined ? 1_000 : Math.max(50, BUDGET_WINDOW_MS - (this.now() - oldest) + 1);
      await this.sleep(waitMs);
    }
  }

  /**
   * Run `work` as this CLI's only in-flight process, no sooner than the minimum
   * gap after its previous spawn.
   */
  async run<T>(cli: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(cli) ?? Promise.resolve();
    const chained = previous.then(async () => {
      const meter = this.meterFor(cli);
      const waited = this.now() - meter.lastSpawnAt;
      if (waited < this.options.minGapMs) {
        await this.sleep(this.options.minGapMs - waited);
      }
      meter.lastSpawnAt = this.now();
      meter.spentInWindow += 1;
      return work();
    });
    // Keep the chain alive on failure so one crashed run does not wedge the CLI.
    this.queues.set(
      cli,
      chained.catch(() => undefined),
    );
    return chained;
  }
}
