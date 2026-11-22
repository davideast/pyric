/**
 * Exponential backoff for served Firestore `runTransaction` retries (#1960).
 *
 * Mirrors `@firebase/firestore` 4.17.2 `ExponentialBackoff` used by
 * `TransactionRunner`: 0 ms on the first attempt, then 1000 ms initial delay,
 * factor 1.5, 60 s cap, +/- 50% jitter, subtracting elapsed time since the
 * start of the previous attempt.
 */

const TXN_BACKOFF_INITIAL_DELAY_MS = 1000;
const TXN_BACKOFF_FACTOR = 1.5;
const TXN_BACKOFF_MAX_DELAY_MS = 60_000;

interface TransactionBackoffClock {
  readonly now: () => number;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const DEFAULT_CLOCK: TransactionBackoffClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
};

export class TransactionRetryBackoff {
  private currentBaseMs = 0;
  private lastAttemptTime: number;

  constructor(
    private readonly clock: TransactionBackoffClock = DEFAULT_CLOCK,
    private readonly initialDelayMs: number = TXN_BACKOFF_INITIAL_DELAY_MS,
    private readonly backoffFactor: number = TXN_BACKOFF_FACTOR,
    private readonly maxDelayMs: number = TXN_BACKOFF_MAX_DELAY_MS,
  ) {
    this.lastAttemptTime = this.clock.now();
  }

  /**
   * Computes and waits for the remaining backoff delay before the next attempt,
   * updates `lastAttemptTime` when the attempt begins, and advances the base
   * delay for any subsequent retry.
   */
  async waitForNextAttempt(): Promise<number> {
    const jitterMs = (this.clock.random() - 0.5) * this.currentBaseMs;
    const desiredDelayWithJitterMs = Math.floor(this.currentBaseMs + jitterMs);
    const delaySoFarMs = Math.max(0, this.clock.now() - this.lastAttemptTime);
    const remainingDelayMs = Math.max(0, desiredDelayWithJitterMs - delaySoFarMs);

    let nextBaseMs = this.currentBaseMs * this.backoffFactor;
    if (nextBaseMs < this.initialDelayMs) {
      nextBaseMs = this.initialDelayMs;
    }
    if (nextBaseMs > this.maxDelayMs) {
      nextBaseMs = this.maxDelayMs;
    }
    this.currentBaseMs = nextBaseMs;

    if (remainingDelayMs > 0) {
      await this.clock.sleep(remainingDelayMs);
    }
    this.lastAttemptTime = this.clock.now();
    return remainingDelayMs;
  }
}
