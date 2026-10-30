/**
 * Rate-limit handling for calls to the rules endpoints: RTDB's
 * `/.settings/rules.json` and run-data store (the rtdb-rules rig and the
 * rtdb-climb probes), and the Firestore and Storage Rules API (the oracle
 * rules session). Production answers a burst of large dry runs with
 * `429 Request rate limit exceeded`. A 429 is waited out with exponential
 * back-off, honouring `Retry-After`, under a cap on the total wait, so a
 * throttled restore read retries instead of reporting a failed restore.
 */

export interface RateLimitPolicy {
  /** The first back-off, doubled after each 429. */
  initialDelayMs: number;
  /** The longest single wait, whether from back-off or `Retry-After`. */
  maxDelayMs: number;
  /** The most the call waits across every retry before it gives up. */
  maxTotalWaitMs: number;
}

/** The back-off every rules endpoint call uses, RTDB or Rules API. */
export const RULES_ENDPOINT_RATE_LIMIT: RateLimitPolicy = {
  initialDelayMs: 5_000,
  maxDelayMs: 120_000,
  maxTotalWaitMs: 15 * 60_000,
};

/**
 * The wait `Retry-After` asks for, in milliseconds: delta-seconds or an HTTP
 * date. Undefined when the header is absent or unreadable.
 */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export interface RateLimitDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

const defaultDeps: RateLimitDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(message),
};

/** The default dependencies with some replaced, such as a fake `fetch` or `sleep`. */
export function rateLimitDeps(overrides: Partial<RateLimitDeps>): RateLimitDeps {
  return { ...defaultDeps, ...overrides };
}

export interface RateLimitOptions {
  policy?: RateLimitPolicy;
  deps?: RateLimitDeps;
  /** Each request's own limit, as a fresh `AbortSignal.timeout`; a 429 wait is not counted against it. */
  timeoutMs?: number;
  /** Starts each back-off log line. */
  logPrefix?: string;
}

function requestInit(init: RequestInit | undefined, timeoutMs: number | undefined): RequestInit | undefined {
  if (timeoutMs === undefined) return init;
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * `fetch` that waits out a 429 and sends the request again. Any other status
 * returns at once. When the next wait would pass `maxTotalWaitMs`, the last
 * 429 response is returned for the caller to report.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit | undefined,
  label: string,
  options: RateLimitOptions = {},
): Promise<Response> {
  const policy = options.policy ?? RULES_ENDPOINT_RATE_LIMIT;
  const deps = options.deps ?? defaultDeps;
  const logPrefix = options.logPrefix ?? '[oracle:rules-rtdb]';
  let waited = 0;
  let backoff = policy.initialDelayMs;
  for (;;) {
    const res = await deps.fetch(url, requestInit(init, options.timeoutMs));
    const isThrottled = res.status === 429;
    if (!isThrottled) return res;
    const asked = retryAfterMs(res.headers.get('retry-after'), deps.now());
    const delay = Math.min(asked ?? backoff, policy.maxDelayMs);
    const wouldPassCap = waited + delay > policy.maxTotalWaitMs;
    if (wouldPassCap) return res;
    await res.body?.cancel();
    deps.log(`${logPrefix} ${label} answered 429; waiting ${Math.round(delay / 1_000)}s before a retry.`);
    await deps.sleep(delay);
    waited += delay;
    backoff = Math.min(backoff * 2, policy.maxDelayMs);
  }
}
