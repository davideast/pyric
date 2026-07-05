/**
 * Polling helper for Cloud Functions long-running operations.
 *
 * The deploy POST/PATCH returns immediately with `{ name, done: false }`
 * — we then GET that operation until `done: true` (success in
 * `response`, failure in `error`). Backoff is exponential capped at
 * 10s; total deadline 5 min, which fits the longest cold deploys
 * we've observed for trivial functions. Bump if real workloads hit
 * the cap.
 */
import type { Operation } from './types.js';

const FUNCTIONS_API = 'https://cloudfunctions.googleapis.com/v2';
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;
const BACKOFF_MULTIPLIER = 1.5;

export type PollResult =
  | { kind: 'ok'; operation: Operation }
  | { kind: 'failed'; operation: Operation }
  | { kind: 'timeout' }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error'; message: string };

export interface PollOptions {
  /** Override the 5-minute deadline. */
  deadlineMs?: number;
  /** Override the initial backoff (mostly for tests). */
  initialBackoffMs?: number;
  /** Override the cap (mostly for tests). */
  maxBackoffMs?: number;
  /** Test seam: replaces the default `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export async function pollOperation(
  operationName: string,
  accessToken: string,
  options: PollOptions = {},
): Promise<PollResult> {
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const sleep = options.sleep ?? defaultSleep;
  let backoff = options.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const cap = options.maxBackoffMs ?? MAX_BACKOFF_MS;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${FUNCTIONS_API}/${operationName}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { kind: 'http_error', status: res.status, body };
    }
    const op = (await res.json()) as Operation;
    if (op.done) {
      return op.error ? { kind: 'failed', operation: op } : { kind: 'ok', operation: op };
    }
    await sleep(backoff);
    backoff = Math.min(backoff * BACKOFF_MULTIPLIER, cap);
  }
  return { kind: 'timeout' };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
