/**
 * Rate-limit handling for the rtdb-rules rig's REST calls to
 * `/.settings/rules.json` and the run-data store. Production answers a burst
 * of large dry runs with `429 Request rate limit exceeded`. A 429 is waited
 * out with exponential back-off, honouring `Retry-After`, under a cap on the
 * total wait, so a throttled restore read retries instead of reporting a
 * failed restore.
 */

export interface RateLimitPolicy {
  /** The first back-off, doubled after each 429. */
  initialDelayMs: number;
  /** The longest single wait, whether from back-off or `Retry-After`. */
  maxDelayMs: number;
  /** The most the call waits across every retry before it gives up. */
  maxTotalWaitMs: number;
}

export const RTDB_RULES_RATE_LIMIT: RateLimitPolicy = {
  initialDelayMs: 5_000,
  maxDelayMs: 120_000,
  maxTotalWaitMs: 15 * 60_000,
};

/** The pause after each deploy scenario's dry runs, before the next scenario. */
export const DEPLOY_SCENARIO_GAP_MS = 5_000;

/** The pause after a scenario whose dry runs carry very large rulesets. */
export const LARGE_RULESET_GAP_MS = 60_000;

/** Deploy scenarios whose rulesets production is slow to validate. */
export const LARGE_RULESET_SCENARIO_IDS: ReadonlySet<string> = new Set([
  'r51-deploy-anchor-index-and-length-probes',
  'r61-deploy-regex-3000-groups',
]);

export function deployScenarioGapMs(scenarioId: string): number {
  return LARGE_RULESET_SCENARIO_IDS.has(scenarioId) ? LARGE_RULESET_GAP_MS : DEPLOY_SCENARIO_GAP_MS;
}

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

/**
 * `fetch` that waits out a 429 and sends the request again. Any other status
 * returns at once. When the next wait would pass `maxTotalWaitMs`, the last
 * 429 response is returned for the caller to report.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit | undefined,
  label: string,
  policy: RateLimitPolicy = RTDB_RULES_RATE_LIMIT,
  deps: RateLimitDeps = defaultDeps,
): Promise<Response> {
  let waited = 0;
  let backoff = policy.initialDelayMs;
  for (;;) {
    const res = await deps.fetch(url, init);
    const isThrottled = res.status === 429;
    if (!isThrottled) return res;
    const asked = retryAfterMs(res.headers.get('retry-after'), deps.now());
    const delay = Math.min(asked ?? backoff, policy.maxDelayMs);
    const wouldPassCap = waited + delay > policy.maxTotalWaitMs;
    if (wouldPassCap) return res;
    await res.body?.cancel();
    deps.log(`[oracle:rules-rtdb] ${label} answered 429; waiting ${Math.round(delay / 1_000)}s before a retry.`);
    await deps.sleep(delay);
    waited += delay;
    backoff = Math.min(backoff * 2, policy.maxDelayMs);
  }
}
