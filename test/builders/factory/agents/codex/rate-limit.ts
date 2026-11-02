/**
 * What the upstream says about its rate limit, read by the forwarder from
 * each response. Every response carries a used-percent and a reset-at
 * (Unix seconds) header for each of two windows, primary and secondary
 * (seen in the factory's experiment; the names are built in `headerReset`
 * and `rateLimitOf` below), and a request over the limit gets `429` with a
 * JSON error body whose `type` is one of `LIMIT_ERROR_TYPES` and whose
 * `resets_at` names the reset in Unix seconds. The agent itself only prints
 * the reset as local wall-clock text, so the forwarder's record is where an
 * exact reset comes from.
 */
import { z } from 'zod';
import type { Headers, RateLimit } from '../../agent.ts';

const WINDOWS = ['primary', 'secondary'] as const;

/** Error types the upstream gives a request over its rate limit. */
const LIMIT_ERROR_TYPES = new Set(['usage_limit_reached', 'rate_limit_exceeded', 'usage_not_included']);

const errorSchema = z.object({
  error: z.object({ type: z.string().optional(), resets_at: z.number().optional(), resets_in_seconds: z.number().optional() }).passthrough(),
}).passthrough();

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function numberHeader(headers: Headers, name: string): number | null {
  const value = Number(header(headers, name));
  const isNumber = header(headers, name) !== undefined && Number.isFinite(value);
  return isNumber ? value : null;
}

const fromUnixSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The body's limit error, when the body is one. */
function limitError(body: string): z.infer<typeof errorSchema>['error'] | undefined {
  try {
    const parsed = errorSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return undefined;
    const isLimit = LIMIT_ERROR_TYPES.has(parsed.data.error.type ?? '');
    return isLimit ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

/** The reset a limit error names: its `resets_at`, else `resets_in_seconds` from `now`. */
function errorReset(error: NonNullable<ReturnType<typeof limitError>>, now: Date): string | null {
  if (error.resets_at !== undefined) return fromUnixSeconds(error.resets_at);
  if (error.resets_in_seconds !== undefined) return new Date(now.getTime() + error.resets_in_seconds * 1000).toISOString();
  return null;
}

/**
 * The latest reset among the windows that are full: past the limit,
 * requests pass again only once every full window has reset.
 */
function headerReset(headers: Headers): string | null {
  const resets = WINDOWS.flatMap((window) => {
    const isFull = (numberHeader(headers, `x-codex-${window}-used-percent`) ?? 0) >= 100;
    const at = numberHeader(headers, `x-codex-${window}-reset-at`);
    return isFull && at !== null ? [at] : [];
  });
  if (resets.length === 0) return null;
  return fromUnixSeconds(Math.max(...resets));
}

/** What a response says about the limits. `body` is read only for a 429, the one status whose body names a reset. */
export function rateLimitOf(status: number, headers: Headers, body: string, now: Date = new Date()): RateLimit {
  const limitReached = status === 429;
  const error = limitReached ? limitError(body) : undefined;
  const resetAt = (error === undefined ? null : errorReset(error, now)) ?? (limitReached ? headerReset(headers) : null);
  const usedPercent: Record<string, number> = {};
  for (const window of WINDOWS) {
    const used = numberHeader(headers, `x-codex-${window}-used-percent`);
    if (used !== null) usedPercent[window] = used;
  }
  return { limitReached, resetAt, usedPercent };
}
