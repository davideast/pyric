/**
 * Proactive App Check token refresher, matching `@firebase/app-check` 0.13.1
 * (`Refresher` and `createTokenRefresher`).
 *
 * Schedule:
 * - No cached token: run immediately (`delay = 0`).
 * - Valid cached token: refresh at `issuedAt + 0.5 * ttl + 5 minutes`, never
 *   later than `expireTime - 5 minutes`, clamped to `>= 0`.
 * - Failed refresh: retry with exponential backoff starting at 30 seconds and
 *   doubling up to 16 minutes; resets to 30 seconds on the next success.
 *
 * Timers are cleared via `clearTimeout` on `stop()` and unreferenced in Node
 * or Bun when `.unref()` is present so a proactive refresh does not hold a
 * short-lived process open on exit. When backed by a `SandboxClock`, the
 * refresher re-arms its pending wait on clock transitions (`set` / `advance` /
 * `reset`) so virtual time drives both refresh and retry backoff without
 * sleeping for wall-clock minutes.
 */
import type { SandboxClock } from '../sandbox/clock.js';
import { utf8FromBase64url } from '../sandbox/internal/sandbox-jwt.js';

/** Default proactive refresh buffer before midpoint and expiry (5 minutes). */
export const TOKEN_REFRESH_BUFFER_MILLIS = 5 * 60 * 1000;

/** Initial retry delay after a failed token refresh (30 seconds). */
export const TOKEN_REFRESH_MIN_RETRY_WAIT_MILLIS = 30 * 1000;

/** Maximum retry delay after repeated refresh failures (16 minutes). */
export const TOKEN_REFRESH_MAX_RETRY_WAIT_MILLIS = 16 * 60 * 1000;

/** Largest delay safe for `setTimeout` (signed 32-bit integer max in ms). */
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;

export interface TimedAppCheckToken {
  readonly token: string;
  readonly issuedAtTimeMillis: number;
  readonly expireTimeMillis: number;
}

export interface TokenRefresherOptions {
  operation: () => Promise<void>;
  getWaitDuration: () => number;
  now: () => number;
  subscribeClock?: (listener: () => void) => () => void;
  retryPolicy?: (error: unknown) => boolean;
  lowerBoundMillis?: number;
  upperBoundMillis?: number;
}

/**
 * Extracts `iat` (in milliseconds) from a JWT token string when valid,
 * matching upstream `CustomProvider.getToken` (`@firebase/app-check` 0.13.1).
 * Falls back to `nowMillis` for opaque or malformed tokens.
 */
export function issuedAtTimeMillisOf(token: string, nowMillis: number): number {
  const segments = token.split('.');
  if (segments.length !== 3) return nowMillis;
  const payloadSegment = segments[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) return nowMillis;
  try {
    const parsed = JSON.parse(utf8FromBase64url(payloadSegment)) as { iat?: unknown } | null;
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.iat === 'number') {
      const iatSeconds = parsed.iat;
      if (Number.isFinite(iatSeconds) && iatSeconds > 0 && iatSeconds < nowMillis) {
        return iatSeconds * 1000;
      }
    }
  } catch (err) {
    // Non-JWT or invalid base64url payloads fall back to the receipt instant.
    void err;
  }
  return nowMillis;
}

/**
 * Wait duration in milliseconds until the next proactive token refresh, per
 * `@firebase/app-check` 0.13.1 `createTokenRefresher`:
 * `min(issuedAt + 0.5 * (expire - issuedAt) + 5m, expire - 5m) - now`, clamped
 * at `>= 0`. Returns `0` when no token is cached.
 */
export function computeNextRefreshDelayMillis(
  token: Pick<TimedAppCheckToken, 'issuedAtTimeMillis' | 'expireTimeMillis'> | null,
  nowMillis: number,
): number {
  if (token === null) return 0;
  const ttlMillis = token.expireTimeMillis - token.issuedAtTimeMillis;
  const midpointPlusBuffer =
    token.issuedAtTimeMillis + ttlMillis * 0.5 + TOKEN_REFRESH_BUFFER_MILLIS;
  const latestAllowableRefresh = token.expireTimeMillis - TOKEN_REFRESH_BUFFER_MILLIS;
  const nextRefreshTimeMillis = Math.min(midpointPlusBuffer, latestAllowableRefresh);
  return Math.max(0, nextRefreshTimeMillis - nowMillis);
}

function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    const unref = (handle as { unref?: unknown }).unref;
    if (typeof unref === 'function') {
      (unref as () => void).call(handle);
    }
  }
}

type RefresherPhase = 'idle' | 'sleeping-success' | 'sleeping-error' | 'running-op';

export class TokenRefresher {
  private readonly operation: () => Promise<void>;
  private readonly getWaitDuration: () => number;
  private readonly now: () => number;
  private readonly subscribeClock: ((listener: () => void) => () => void) | undefined;
  private readonly retryPolicy: (error: unknown) => boolean;
  private readonly lowerBoundMillis: number;
  private readonly upperBoundMillis: number;

  private running = false;
  private generation = 0;
  private phase: RefresherPhase = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeClock: (() => void) | null = null;
  private nextErrorWaitMillis: number;
  private retryDeadlineMillis = 0;
  private delayWasClamped = false;

  constructor(options: TokenRefresherOptions) {
    const lowerBound = options.lowerBoundMillis ?? TOKEN_REFRESH_MIN_RETRY_WAIT_MILLIS;
    const upperBound = options.upperBoundMillis ?? TOKEN_REFRESH_MAX_RETRY_WAIT_MILLIS;
    if (lowerBound > upperBound) {
      throw new Error('Proactive refresh lower bound greater than upper bound!');
    }
    this.operation = options.operation;
    this.getWaitDuration = options.getWaitDuration;
    this.now = options.now;
    this.subscribeClock = options.subscribeClock;
    this.retryPolicy = options.retryPolicy ?? (() => true);
    this.lowerBoundMillis = lowerBound;
    this.upperBoundMillis = upperBound;
    this.nextErrorWaitMillis = lowerBound;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.stop();
    this.running = true;
    this.nextErrorWaitMillis = this.lowerBoundMillis;
    if (this.subscribeClock !== undefined) {
      this.unsubscribeClock = this.subscribeClock(() => {
        this.onClockChanged();
      });
    }
    this.schedule(true);
  }

  stop(): void {
    this.generation += 1;
    this.running = false;
    this.phase = 'idle';
    this.delayWasClamped = false;
    this.clearPendingTimer();
    if (this.unsubscribeClock !== null) {
      this.unsubscribeClock();
      this.unsubscribeClock = null;
    }
  }

  private clearPendingTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(hasSucceeded: boolean): void {
    if (!this.running) return;
    const gen = this.generation;
    let delayMillis: number;
    if (hasSucceeded) {
      this.nextErrorWaitMillis = this.lowerBoundMillis;
      this.phase = 'sleeping-success';
      delayMillis = Math.max(0, this.getWaitDuration());
    } else {
      delayMillis = this.nextErrorWaitMillis;
      this.nextErrorWaitMillis = Math.min(this.nextErrorWaitMillis * 2, this.upperBoundMillis);
      this.phase = 'sleeping-error';
      this.retryDeadlineMillis = this.now() + delayMillis;
    }
    this.armTimer(delayMillis, gen);
  }

  private armTimer(delayMillis: number, gen: number): void {
    this.clearPendingTimer();
    if (!this.running || this.generation !== gen) return;
    const normalized = Math.max(0, delayMillis);
    const exceedsMax = normalized > MAX_TIMER_DELAY_MILLIS;
    const timeoutDelay = Math.min(normalized, MAX_TIMER_DELAY_MILLIS);
    this.delayWasClamped = exceedsMax;
    const handle = setTimeout(() => {
      void this.onTimerFired(gen);
    }, timeoutDelay);
    unrefTimer(handle);
    this.timer = handle;
  }

  private onClockChanged(): void {
    if (!this.running) return;
    const gen = this.generation;
    if (this.phase === 'sleeping-success') {
      this.armTimer(this.getWaitDuration(), gen);
      return;
    }
    if (this.phase === 'sleeping-error') {
      const remaining = Math.max(0, this.retryDeadlineMillis - this.now());
      this.armTimer(remaining, gen);
    }
  }

  private async onTimerFired(gen: number): Promise<void> {
    if (!this.running || this.generation !== gen) return;
    this.timer = null;
    if (this.delayWasClamped) {
      this.delayWasClamped = false;
      if (this.phase === 'sleeping-success') {
        const remaining = Math.max(0, this.getWaitDuration());
        if (remaining > 0) {
          this.armTimer(remaining, gen);
          return;
        }
      } else if (this.phase === 'sleeping-error') {
        const remaining = Math.max(0, this.retryDeadlineMillis - this.now());
        if (remaining > 0) {
          this.armTimer(remaining, gen);
          return;
        }
      }
    }
    this.phase = 'running-op';
    try {
      await this.operation();
      if (!this.running || this.generation !== gen) return;
      this.schedule(true);
    } catch (error) {
      if (!this.running || this.generation !== gen) return;
      if (this.retryPolicy(error)) {
        this.schedule(false);
      } else {
        this.stop();
      }
    }
  }
}

export function bindSandboxClockSubscriber(
  clock: SandboxClock | null,
): ((listener: () => void) => () => void) | undefined {
  if (clock === null) return undefined;
  return (listener) => clock.onChange(() => listener());
}
