/**
 * How long to pause after a rate limit: until the reset time the session
 * gave, or, without one, a backoff that doubles with each limit in a row.
 * Never past the deadline.
 */

const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export interface Pause {
  until: number;
  source: 'reset-at' | 'backoff';
}

export function backoffMs(streak: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, streak - 1));
}

/** `streak` counts this limit: 1 for the first in a row. */
export function pauseAfterRateLimit(resetAt: string | undefined, streak: number, now: number, deadline: number): Pause {
  const reset = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  const hasFutureReset = Number.isFinite(reset) && reset > now;
  const pause: Pause = hasFutureReset ? { until: reset, source: 'reset-at' } : { until: now + backoffMs(streak), source: 'backoff' };
  return { ...pause, until: Math.min(pause.until, deadline) };
}
