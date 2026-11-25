/**
 * Endpoint resilience primitives for RTDB rules oracle captures:
 *   1. Proactive + 401-triggered OAuth access-token refresh so long runs
 *      (429 backoffs + large-ruleset timeouts + 10-minute cooldown) never fail
 *      final restore or data cleanup on an expired 1-hour token.
 *   2. Paced large-ruleset dry-run wrapper that spaces consecutive cases and
 *      backs off after timeouts/5xx/429s instead of hammering the endpoint.
 *   3. Timeout error normalization so AbortError/socket timeouts under an
 *      explicit request timeout map reliably to `TimeoutError` (`DryRunUnanswered`).
 *   4. Bounded retry around the pre-late-phase rules restore read-back check.
 */
import {
  ORACLE_RESTORE_ATTEMPTS,
  type SignalRestoreCoordinator,
} from './oracle-signal-restore.ts';
import {
  restoreRulesBeforeLatePhase,
  type RulesRestoreEndpoint,
} from './rtdb-rules-capture-run.ts';
import type { RunDataStore } from './rtdb-rules-cleanup.ts';
import type { RulesDeployEndpoint } from './rtdb-rules-deploy.ts';
import {
  fetchWithRateLimitRetry,
  rateLimitDeps,
  type RateLimitDeps,
  type RateLimitOptions,
} from './rtdb-rules-rate-limit.ts';

/** Refresh cached 1-hour OAuth tokens at 45 minutes, well before expiry. */
export const DEFAULT_ACCESS_TOKEN_REFRESH_MS = 45 * 60_000;

/** Pause between consecutive cases within a large-ruleset deploy scenario (e.g. r51). */
export const LARGE_RULESET_CASE_GAP_MS = 5_000;

/** First cooldown after a large-ruleset dry-run timeout, 5xx, or 429 before retrying. */
export const LARGE_RULESET_RETRY_INITIAL_DELAY_MS = 15_000;

/** Cap on consecutive large-ruleset retry cooldowns. */
export const LARGE_RULESET_RETRY_MAX_DELAY_MS = 60_000;

/** Default pause before retrying a lagged pre-late-phase rules read-back. */
const RESTORE_BEFORE_LATE_RETRY_DELAY_MS = 2_000;

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export interface RefreshingAccessToken {
  get(forceRefresh?: boolean): Promise<string>;
}

export interface RefreshingAccessTokenOptions {
  mint: () => Promise<string>;
  now?: () => number;
  refreshAfterMs?: number;
}

/**
 * Caches an OAuth access token and refreshes it proactively once its age
 * reaches `refreshAfterMs`, or immediately when `forceRefresh` is true.
 * Concurrent callers share a single in-flight mint.
 */
export function createRefreshingAccessToken(
  options: RefreshingAccessTokenOptions,
): RefreshingAccessToken {
  const now = options.now ?? (() => Date.now());
  const refreshAfterMs = options.refreshAfterMs ?? DEFAULT_ACCESS_TOKEN_REFRESH_MS;
  let cached: { token: string; mintedAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  return {
    async get(forceRefresh = false): Promise<string> {
      const hasFreshCache =
        !forceRefresh && cached !== null && now() - cached.mintedAt < refreshAfterMs;
      if (hasFreshCache && cached !== null) {
        return cached.token;
      }
      if (inFlight !== null) {
        return inFlight;
      }
      const mintPromise = options.mint().then((token) => {
        cached = { token, mintedAt: now() };
        return token;
      });
      inFlight = mintPromise;
      try {
        return await mintPromise;
      } finally {
        inFlight = null;
      }
    },
  };
}

export interface TokenRateLimitOptions extends RateLimitOptions {
  tokenProvider: RefreshingAccessToken;
}

function buildRetryInit(
  baseInit: RequestInit | undefined,
  timeoutMs: number | undefined,
): RequestInit | undefined {
  if (timeoutMs === undefined) {
    return baseInit;
  }
  return { ...baseInit, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Sends a REST request using a fresh OAuth token on every attempt (including
 * across 429 retry loops), and retries once with a force-refreshed token on
 * HTTP 401 so long capture runs never fail cleanup due to token expiration.
 */
export async function fetchWithTokenAndRateLimitRetry(
  buildUrl: (token: string) => string,
  init: RequestInit | undefined,
  label: string,
  options: TokenRateLimitOptions,
): Promise<Response> {
  const baseDeps: RateLimitDeps = options.deps ?? rateLimitDeps({});
  const logPrefix = options.logPrefix ?? '[oracle:rules-rtdb]';

  const wrappedDeps: RateLimitDeps = {
    ...baseDeps,
    async fetch(_placeholderUrl: string, reqInit?: RequestInit): Promise<Response> {
      const token = await options.tokenProvider.get(false);
      const firstResponse = await baseDeps.fetch(buildUrl(token), reqInit);
      if (firstResponse.status !== 401) {
        return firstResponse;
      }
      await firstResponse.body?.cancel();
      baseDeps.log(`${logPrefix} ${label} answered 401; refreshing access token and retrying once.`);
      const freshToken = await options.tokenProvider.get(true);
      const retryInit = buildRetryInit(init, options.timeoutMs);
      return baseDeps.fetch(buildUrl(freshToken), retryInit);
    },
  };

  return fetchWithRateLimitRetry('token-authenticated-request', init, label, {
    policy: options.policy,
    deps: wrappedDeps,
    timeoutMs: options.timeoutMs,
    logPrefix,
  });
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    return code;
  }
  return undefined;
}

function isTimeoutLikeError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return true;
  }
  const code = errorCodeOf(error);
  if (code !== undefined && TIMEOUT_ERROR_CODES.has(code)) {
    return true;
  }
  return false;
}

/**
 * Ensures runtime-specific timeout aborts (such as AbortError or socket timeout
 * codes when `timeoutMs` is configured) surface with `name === 'TimeoutError'`
 * so `rtdb-rules-deploy.ts` classifies them as `DryRunUnanswered`.
 */
export function normalizeDryRunTimeoutError(
  error: unknown,
  timeoutMs: number | undefined,
): unknown {
  if (timeoutMs === undefined) {
    return error;
  }
  if (!isTimeoutLikeError(error)) {
    return error;
  }
  if (error.name === 'TimeoutError') {
    return error;
  }
  return new DOMException(error.message || 'The operation timed out.', 'TimeoutError');
}

export interface PacedDryRunOptions {
  interCaseGapMs?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Wraps a `RulesDeployEndpoint` so large-ruleset dry runs (`timeoutMs !== undefined`)
 * space consecutive cases and back off exponentially after timeouts, 5xx, or 429
 * answers instead of immediately retrying into a throttled endpoint. Ordinary
 * dry runs (`timeoutMs === undefined`) pass straight through without delay.
 */
export function createPacedDryRunEndpoint(
  base: RulesDeployEndpoint,
  options: PacedDryRunOptions = {},
): RulesDeployEndpoint {
  const interCaseGapMs = options.interCaseGapMs ?? LARGE_RULESET_CASE_GAP_MS;
  const initialRetryDelayMs =
    options.initialRetryDelayMs ?? LARGE_RULESET_RETRY_INITIAL_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? LARGE_RULESET_RETRY_MAX_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.log(line));

  let hasSentLargeDryRun = false;
  let consecutiveLargeFailures = 0;

  return {
    async dryRun(rules, callOptions = {}) {
      const isLargeRulesetCall = callOptions.timeoutMs !== undefined;
      if (isLargeRulesetCall && hasSentLargeDryRun) {
        if (consecutiveLargeFailures > 0) {
          const exponent = consecutiveLargeFailures - 1;
          const retryDelay = Math.min(
            initialRetryDelayMs * Math.pow(2, exponent),
            maxRetryDelayMs,
          );
          log(
            `[oracle:rules-rtdb] waiting ${Math.round(retryDelay / 1_000)}s before retrying large-ruleset dry run.`,
          );
          await sleep(retryDelay);
        } else if (interCaseGapMs > 0) {
          await sleep(interCaseGapMs);
        }
      }

      if (isLargeRulesetCall) {
        hasSentLargeDryRun = true;
      }

      try {
        const res = await base.dryRun(rules, callOptions);
        if (isLargeRulesetCall) {
          const isTransientFailure = res.status >= 500 || res.status === 429;
          if (isTransientFailure) {
            consecutiveLargeFailures += 1;
          } else {
            consecutiveLargeFailures = 0;
          }
        }
        return res;
      } catch (error) {
        if (isLargeRulesetCall) {
          consecutiveLargeFailures += 1;
        }
        throw normalizeDryRunTimeoutError(error, callOptions.timeoutMs);
      }
    },
    readRules: () => base.readRules(),
  };
}

export interface RestoreBeforeLateRetryOptions {
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Runs `restoreRulesBeforeLatePhase` with bounded retries so brief RTDB rules
 * propagation lag on read-back does not abort the capture before late deploys.
 */
export async function restoreBeforeLatePhaseWithRetry(
  endpoint: RulesRestoreEndpoint,
  beforeRules: Record<string, unknown>,
  options: RestoreBeforeLateRetryOptions = {},
): Promise<void> {
  const maxAttempts = options.attempts ?? ORACLE_RESTORE_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? RESTORE_BEFORE_LATE_RETRY_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.log(line));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isLastAttempt = attempt === maxAttempts;
    try {
      await restoreRulesBeforeLatePhase(endpoint, beforeRules);
      return;
    } catch (error) {
      if (isLastAttempt) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      log(
        `[oracle:rules-rtdb] pre-late restore attempt ${attempt}/${maxAttempts} failed (${reason}); retrying in ${Math.round(retryDelayMs / 1_000)}s.`,
      );
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
}

export interface RtdbRulesRestClients {
  readRules(): Promise<Record<string, unknown>>;
  writeRules(rules: Record<string, unknown>): Promise<void>;
  endpoint: RulesDeployEndpoint;
  store: RunDataStore;
}

export interface RtdbRulesRestClientOptions {
  databaseUrl: string;
  tokenProvider: RefreshingAccessToken;
  coordinator: SignalRestoreCoordinator;
  parseRules: (source: string) => Record<string, unknown>;
  logPrefix?: string;
}

/**
 * Builds token-refreshing, 429-resilient REST clients for rules reads,
 * rules writes, paced dry runs, and run-data cleanup on one RTDB instance.
 */
export function createRtdbRulesRestClients(
  options: RtdbRulesRestClientOptions,
): RtdbRulesRestClients {
  const logPrefix = options.logPrefix ?? '[oracle:rules-rtdb]';
  const { databaseUrl, tokenProvider, coordinator, parseRules } = options;

  const buildRulesGetUrl = (token: string): string =>
    `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(token)}`;
  const buildRulesPutUrl = (token: string): string =>
    `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(token)}&print=silent`;
  const buildRulesDryRunUrl = (token: string): string =>
    `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(token)}&dryRun=true`;

  async function readRules(): Promise<Record<string, unknown>> {
    const res = await fetchWithTokenAndRateLimitRetry(buildRulesGetUrl, undefined, 'read rules', {
      tokenProvider,
      logPrefix,
    });
    if (!res.ok) {
      throw new Error(`read rules failed: ${res.status} ${await res.text()}`);
    }
    return parseRules(await res.text());
  }

  const rawEndpoint: RulesDeployEndpoint = {
    async dryRun(rules, callOptions = {}) {
      const started = Date.now();
      let limit = 'default limit';
      if (callOptions.timeoutMs !== undefined) {
        limit = `limit ${callOptions.timeoutMs / 1_000}s`;
      }
      try {
        const res = await fetchWithTokenAndRateLimitRetry(
          buildRulesDryRunUrl,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules }),
          },
          'dry run',
          { tokenProvider, timeoutMs: callOptions.timeoutMs, logPrefix },
        );
        const body = await res.text();
        if (callOptions.timeoutMs !== undefined) {
          console.log(
            `${logPrefix} dry run answered ${res.status} in ${Date.now() - started}ms (${limit}).`,
          );
        }
        return { status: res.status, body };
      } catch (error) {
        const errorName = error instanceof Error ? error.name : String(error);
        console.log(
          `${logPrefix} dry run failed after ${Date.now() - started}ms (${limit}): ${errorName}`,
        );
        throw error;
      }
    },
    readRules,
  };

  async function writeRules(rules: Record<string, unknown>): Promise<void> {
    const res = await coordinator.trackMutation(
      fetchWithTokenAndRateLimitRetry(
        buildRulesPutUrl,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules }),
        },
        'write rules',
        { tokenProvider, logPrefix },
      ),
    );
    if (!res.ok) {
      throw new Error(`write rules failed: ${res.status} ${await res.text()}`);
    }
  }

  const store: RunDataStore = {
    async deleteNamespace(auditKey: string): Promise<void> {
      const res = await fetchWithTokenAndRateLimitRetry(
        (token) =>
          `${databaseUrl}/${auditKey}.json?access_token=${encodeURIComponent(token)}&print=silent`,
        { method: 'DELETE' },
        'delete run data',
        { tokenProvider, logPrefix },
      );
      if (!res.ok) {
        throw new Error(`delete run data failed: ${res.status} ${await res.text()}`);
      }
    },
    async shallowRootKeys(): Promise<string[]> {
      const res = await fetchWithTokenAndRateLimitRetry(
        (token) => `${databaseUrl}/.json?shallow=true&access_token=${encodeURIComponent(token)}`,
        undefined,
        'shallow root read',
        { tokenProvider, logPrefix },
      );
      if (!res.ok) {
        throw new Error(`shallow root read failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as Record<string, unknown> | null;
      if (body === null) {
        return [];
      }
      return Object.keys(body);
    },
  };

  return {
    readRules,
    writeRules,
    endpoint: createPacedDryRunEndpoint(rawEndpoint),
    store,
  };
}
