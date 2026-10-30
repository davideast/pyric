import { describe, expect, it } from 'bun:test';
import {
  DEPLOY_SCENARIO_GAP_MS,
  LARGE_RULESET_GAP_MS,
  LARGE_RULESET_SCENARIO_IDS,
  deployScenarioGapMs,
  fetchWithRateLimitRetry,
  retryAfterMs,
  type RateLimitDeps,
  type RateLimitPolicy,
} from './rtdb-rules-rate-limit.ts';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS } from '../rules-corpus/rtdb/index.ts';

const POLICY: RateLimitPolicy = { initialDelayMs: 1_000, maxDelayMs: 8_000, maxTotalWaitMs: 20_000 };

/** Answers each call with the next status in `statuses`, the last repeating. */
function fakeDeps(statuses: Array<number | { status: number; retryAfter: string }>): RateLimitDeps & {
  calls: number;
  waits: number[];
} {
  const deps = {
    calls: 0,
    waits: [] as number[],
    async fetch() {
      const next = statuses[Math.min(deps.calls, statuses.length - 1)]!;
      deps.calls += 1;
      const answer = typeof next === 'number' ? { status: next } : next;
      const headers = 'retryAfter' in answer ? { 'retry-after': answer.retryAfter } : undefined;
      return new Response(answer.status === 429 ? 'throttled' : 'ok', { status: answer.status, headers });
    },
    async sleep(ms: number) {
      deps.waits.push(ms);
    },
    now: () => Date.parse('2026-10-30T12:00:00Z'),
    log: () => {},
  };
  return deps;
}

describe('rtdb-rules rate-limit retry', () => {
  it('returns a non-429 answer without waiting', async () => {
    const deps = fakeDeps([400]);
    const res = await fetchWithRateLimitRetry('u', undefined, 'dry run', POLICY, deps);
    expect(res.status).toBe(400);
    expect(deps.waits).toEqual([]);
  });

  it('waits out 429s with doubling back-off and returns the answer after them', async () => {
    const deps = fakeDeps([429, 429, 429, 200]);
    const res = await fetchWithRateLimitRetry('u', undefined, 'read rules', POLICY, deps);
    expect(res.status).toBe(200);
    expect(deps.waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('honours Retry-After in seconds and as an HTTP date', async () => {
    const deps = fakeDeps([
      { status: 429, retryAfter: '3' },
      { status: 429, retryAfter: 'Fri, 30 Oct 2026 12:00:05 GMT' },
      200,
    ]);
    await fetchWithRateLimitRetry('u', undefined, 'read rules', POLICY, deps);
    expect(deps.waits).toEqual([3_000, 5_000]);
  });

  it('caps a single wait at maxDelayMs, even when Retry-After asks for more', async () => {
    const deps = fakeDeps([{ status: 429, retryAfter: '600' }, 200]);
    await fetchWithRateLimitRetry('u', undefined, 'read rules', POLICY, deps);
    expect(deps.waits).toEqual([8_000]);
  });

  it('returns the last 429 once the next wait would pass the total cap', async () => {
    const deps = fakeDeps([429]);
    const res = await fetchWithRateLimitRetry('u', undefined, 'read rules', POLICY, deps);
    expect(res.status).toBe(429);
    // 1s + 2s + 4s + 8s = 15s; another 8s would pass the 20s cap.
    expect(deps.waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(deps.calls).toBe(5);
  });

  it('reads Retry-After forms and ignores what it cannot read', () => {
    expect(retryAfterMs(null, 0)).toBeUndefined();
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(' 7 ', 0)).toBe(7_000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT', 10_000)).toBe(0);
  });
});

describe('deploy scenario spacing', () => {
  it('names only deploy scenarios the corpus has', () => {
    const ids = new Set(ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((scenario) => scenario.id));
    for (const id of LARGE_RULESET_SCENARIO_IDS) expect(ids.has(id)).toBe(true);
  });

  it('pauses longer after the large-ruleset scenarios', () => {
    expect(deployScenarioGapMs('r51-deploy-anchor-index-and-length-probes')).toBe(LARGE_RULESET_GAP_MS);
    expect(deployScenarioGapMs('r61-deploy-regex-3000-groups')).toBe(LARGE_RULESET_GAP_MS);
    expect(deployScenarioGapMs('r29-deploy-rejections')).toBe(DEPLOY_SCENARIO_GAP_MS);
  });
});
