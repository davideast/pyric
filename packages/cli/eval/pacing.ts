/**
 * Pacing and throttle detection.
 *
 * Every CLI in the matrix is a metered account. The runner therefore holds one
 * process per CLI at a time, keeps a minimum gap between that CLI's spawns, and
 * stops spending a CLI once it has used its budget inside the current five-hour
 * window. A run that the provider rejected for rate limiting is recorded and not
 * retried, because a retry inside a limit window costs budget and returns the
 * same answer.
 */

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
}

export const DEFAULT_PACING: PacingOptions = {
  minGapMs: 5_000,
  budgetPerWindow: 200,
};

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
