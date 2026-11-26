/**
 * Unit and integration tests for RTDB rules oracle capture resilience (#1692):
 *   - `--exclude-scenario` selection so all 62 observed rules-rtdb-* scenarios
 *     can recapture cleanly without hitting r61, while preserving r61 in the
 *     default corpus run.
 *   - Proactive + 401-triggered OAuth access-token refresh across long 429
 *     retry loops so >60-minute runs never fail restore or data cleanup.
 *   - Large-ruleset dry-run inter-case pacing and retry cooldown backoff
 *     (protecting r51 and r61 against immediate-retry 429 cascades) plus
 *     timeout error normalization into `TimeoutError` (`DryRunUnanswered`).
 *   - Bounded retry around the pre-late-phase rules restore read-back check.
 */
import { describe, expect, it } from 'bun:test';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { runCapturePhases } from '../../src/rtdb-rules-capture-run.ts';
import {
  BEFORE_RULES,
  MOUNT_KEY,
  SINGLE_ATTEMPT,
  deployScenario,
  fakeEndpoint,
} from '../../src/rtdb-rules-deploy-fakes.ts';
import { orderDeployScenarios, runDeployScenarios } from '../../src/rtdb-rules-deploy-run.ts';
import type { RulesDeployEndpoint } from '../../src/rtdb-rules-deploy.ts';
import {
  DEFAULT_ACCESS_TOKEN_REFRESH_MS,
  LARGE_RULESET_CASE_GAP_MS,
  LARGE_RULESET_RETRY_INITIAL_DELAY_MS,
  LARGE_RULESET_RETRY_MAX_DELAY_MS,
  createPacedDryRunEndpoint,
  createRefreshingAccessToken,
  fetchWithTokenAndRateLimitRetry,
  normalizeDryRunTimeoutError,
  restoreBeforeLatePhaseWithRetry,
} from '../../src/rtdb-rules-endpoint-resilience.ts';
import type { RateLimitDeps, RateLimitPolicy } from '../../src/rtdb-rules-rate-limit.ts';
import { selectRtdbScenarios } from '../../src/run-rules-rtdb.ts';

const TEST_RATE_POLICY: RateLimitPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxTotalWaitMs: 30_000,
};

describe('run-rules-rtdb --exclude-scenario selection', () => {
  it('keeps r61 in the default full corpus selection with no hidden skip', () => {
    const selection = selectRtdbScenarios([]);
    expect(selection.deployScenarios.map((s) => s.id)).toContain('r61-deploy-regex-3000-groups');
    expect(selection.scenarios).toHaveLength(ALL_RULES_RTDB_SCENARIOS.length);
    expect(selection.deployScenarios).toHaveLength(ALL_RULES_RTDB_DEPLOY_SCENARIOS.length);
  });

  it('excludes r61 explicitly so all other 62 corpus scenarios recapture cleanly', () => {
    const selection = selectRtdbScenarios([
      '--write',
      '--exclude-scenario',
      'r61-deploy-regex-3000-groups',
    ]);
    expect(selection.scenarios).toHaveLength(ALL_RULES_RTDB_SCENARIOS.length);
    expect(selection.deployScenarios).toHaveLength(ALL_RULES_RTDB_DEPLOY_SCENARIOS.length - 1);
    expect(selection.deployScenarios.map((s) => s.id)).not.toContain(
      'r61-deploy-regex-3000-groups',
    );
    expect(selection.deployScenarios.map((s) => s.id)).toContain(
      'r51-deploy-anchor-index-and-length-probes',
    );
  });

  it('supports comma-separated, repeated, and = forms alongside --scenario', () => {
    const selection = selectRtdbScenarios([
      '--scenario',
      'r14-root-lookup,r15-validate-ancestor-scope,r29-deploy-rejections,r61-deploy-regex-3000-groups',
      '--exclude-scenario=r61-deploy-regex-3000-groups,r14-root-lookup',
    ]);
    expect(selection.scenarios.map((s) => s.id)).toEqual(['r15-validate-ancestor-scope']);
    expect(selection.deployScenarios.map((s) => s.id)).toEqual(['r29-deploy-rejections']);
  });

  it('rejects missing, empty, unknown, or all-eliminating exclusions', () => {
    expect(() => selectRtdbScenarios(['--exclude-scenario'])).toThrow(
      /--exclude-scenario requires an id/,
    );
    expect(() => selectRtdbScenarios(['--exclude-scenario', 'r61-deploy-regex-3000-groups,'])).toThrow(
      /--exclude-scenario requires an id between each comma/,
    );
    expect(() => selectRtdbScenarios(['--exclude-scenario=not-a-scenario'])).toThrow(
      /unknown RTDB scenario: not-a-scenario/,
    );
    expect(() =>
      selectRtdbScenarios([
        '--scenario',
        'r61-deploy-regex-3000-groups',
        '--exclude-scenario',
        'r61-deploy-regex-3000-groups',
      ]),
    ).toThrow(/no RTDB scenarios remain/);
  });
});

describe('RTDB rules refreshing access token and 401/429 retry', () => {
  it('reuses a fresh token, refreshes proactively after TTL, and deduplicates concurrent mints', async () => {
    let clock = 10_000;
    let mintCount = 0;
    const provider = createRefreshingAccessToken({
      now: () => clock,
      refreshAfterMs: DEFAULT_ACCESS_TOKEN_REFRESH_MS,
      mint: async () => {
        mintCount += 1;
        return `tok-${mintCount}`;
      },
    });

    const [a, b] = await Promise.all([provider.get(), provider.get()]);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(mintCount).toBe(1);

    clock += DEFAULT_ACCESS_TOKEN_REFRESH_MS - 1;
    expect(await provider.get()).toBe('tok-1');
    expect(mintCount).toBe(1);

    clock += 1;
    expect(await provider.get()).toBe('tok-2');
    expect(mintCount).toBe(2);

    expect(await provider.get(true)).toBe('tok-3');
    expect(mintCount).toBe(3);
  });

  it('refreshes an expired token across 429 retry waits and retries once on 401', async () => {
    let clock = 0;
    let mintCount = 0;
    const seenUrls: string[] = [];
    const waits: number[] = [];
    const statuses = [429, 401, 200];
    let callIndex = 0;

    const tokenProvider = createRefreshingAccessToken({
      now: () => clock,
      refreshAfterMs: 2_500,
      mint: async () => {
        mintCount += 1;
        return `tok-${mintCount}`;
      },
    });

    const deps: RateLimitDeps = {
      async fetch(url) {
        seenUrls.push(url);
        const status = statuses[Math.min(callIndex, statuses.length - 1)] ?? 200;
        callIndex += 1;
        return new Response(status === 200 ? 'ok' : 'err', { status });
      },
      async sleep(ms) {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
      log: () => {},
    };

    const res = await fetchWithTokenAndRateLimitRetry(
      (token) => `https://oracle.example/.settings/rules.json?access_token=${token}`,
      undefined,
      'read rules',
      { tokenProvider, policy: TEST_RATE_POLICY, deps },
    );

    expect(res.status).toBe(200);
    expect(waits).toEqual([1_000]);
    expect(seenUrls).toEqual([
      'https://oracle.example/.settings/rules.json?access_token=tok-1',
      'https://oracle.example/.settings/rules.json?access_token=tok-1',
      'https://oracle.example/.settings/rules.json?access_token=tok-2',
    ]);
  });

  it('does not loop infinitely when 401 persists after a forced refresh', async () => {
    let mintCount = 0;
    let fetchCount = 0;
    const tokenProvider = createRefreshingAccessToken({
      mint: async () => {
        mintCount += 1;
        return `tok-${mintCount}`;
      },
    });
    const deps: RateLimitDeps = {
      async fetch() {
        fetchCount += 1;
        return new Response('unauthorized', { status: 401 });
      },
      async sleep() {},
      now: () => 0,
      log: () => {},
    };

    const res = await fetchWithTokenAndRateLimitRetry(
      (token) => `https://oracle.example/.settings/rules.json?access_token=${token}`,
      undefined,
      'read rules',
      { tokenProvider, policy: TEST_RATE_POLICY, deps },
    );

    expect(res.status).toBe(401);
    expect(fetchCount).toBe(2);
    expect(mintCount).toBe(2);
  });
});

describe('large-ruleset dry-run pacing and timeout normalization', () => {
  it('normalizes AbortError and socket timeouts to TimeoutError only when timeoutMs is set', () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    const normalized = normalizeDryRunTimeoutError(abortErr, 300_000);
    expect(normalized).toBeInstanceOf(Error);
    expect((normalized as Error).name).toBe('TimeoutError');

    const socketTimeout = Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' });
    const normalizedSocket = normalizeDryRunTimeoutError(socketTimeout, 120_000);
    expect((normalizedSocket as Error).name).toBe('TimeoutError');

    expect(normalizeDryRunTimeoutError(abortErr, undefined)).toBe(abortErr);
    const otherErr = new Error('network refused');
    expect(normalizeDryRunTimeoutError(otherErr, 120_000)).toBe(otherErr);
  });

  it('passes ordinary deploy scenarios through with zero delay and paces large-ruleset cases and retries', async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const base: RulesDeployEndpoint = {
      async dryRun(_rules, options) {
        if (options?.timeoutMs === undefined) {
          return { status: 200, body: '' };
        }
        attempt += 1;
        if (attempt === 1) {
          throw new DOMException('timed out', 'TimeoutError');
        }
        if (attempt === 2) {
          return { status: 503, body: 'unavailable' };
        }
        return { status: 200, body: '' };
      },
      async readRules() {
        return structuredClone(BEFORE_RULES);
      },
    };

    const paced = createPacedDryRunEndpoint(base, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
    });

    // Two ordinary dry runs: no sleeps.
    await paced.dryRun(BEFORE_RULES);
    await paced.dryRun(BEFORE_RULES);
    expect(sleeps).toEqual([]);

    // Large dry run 1 fails with timeout, dry run 2 backs off 15s and hits 503,
    // dry run 3 backs off 30s and succeeds, dry run 4 uses the normal 5s inter-case gap.
    await expect(paced.dryRun(BEFORE_RULES, { timeoutMs: 120_000 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect((await paced.dryRun(BEFORE_RULES, { timeoutMs: 120_000 })).status).toBe(503);
    expect((await paced.dryRun(BEFORE_RULES, { timeoutMs: 120_000 })).status).toBe(200);
    expect((await paced.dryRun(BEFORE_RULES, { timeoutMs: 120_000 })).status).toBe(200);

    expect(sleeps).toEqual([
      LARGE_RULESET_RETRY_INITIAL_DELAY_MS,
      Math.min(LARGE_RULESET_RETRY_INITIAL_DELAY_MS * 2, LARGE_RULESET_RETRY_MAX_DELAY_MS),
      LARGE_RULESET_CASE_GAP_MS,
    ]);
  });

  it('classifies an AbortError on r61 as DryRunUnanswered, keeps all prior observations, and cools down', async () => {
    const r51 = deployScenario('r51-fixture', { timeoutMs: 120_000 });
    const r61 = deployScenario('r61-fixture', SINGLE_ATTEMPT);
    const sleeps: number[] = [];
    const written: string[] = [];
    const logs: string[] = [];

    let r51Calls = 0;
    const rawEndpoint: RulesDeployEndpoint = {
      async dryRun(rules) {
        const mounted = rules[MOUNT_KEY] as Record<string, unknown>;
        const scenarioId = Object.keys(mounted)[0] ?? '';
        if (scenarioId === 'r61-fixture') {
          throw new DOMException('The request was aborted.', 'AbortError');
        }
        if (scenarioId === 'r51-fixture') {
          r51Calls += 1;
          if (r51Calls === 1) {
            throw new DOMException('The operation timed out.', 'TimeoutError');
          }
        }
        return { status: 200, body: '' };
      },
      async readRules() {
        return structuredClone(BEFORE_RULES);
      },
    };

    const paced = createPacedDryRunEndpoint(rawEndpoint, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (line) => {
        logs.push(line);
      },
    });

    const order = orderDeployScenarios([r51, r61]);
    const exitCode = await runCapturePhases({
      earlyDeploys: async () => ({ observations: [], unanswered: [] }),
      operations: async () => [
        { scenario: { id: 'r1-auth-only', fm: 'rtdb#1', rationale: 'fixture' }, behavior: {} },
      ],
      restoreBeforeLate: async () => {},
      lateDeploys: () =>
        runDeployScenarios(
          paced,
          order.afterOperations,
          { beforeRules: BEFORE_RULES, mountKey: MOUNT_KEY },
          {
            sleep: async (ms) => {
              sleeps.push(ms);
            },
            log: (line) => {
              logs.push(line);
            },
          },
        ),
      restoreAndCleanUp: async () => {},
      assertClean: () => {},
      write: (obs) => {
        written.push(obs.scenario.id);
      },
      log: (line) => {
        logs.push(line);
      },
    });

    expect(exitCode).toBe(1);
    expect(written).toEqual(['r1-auth-only', 'r51-fixture']);
    expect(sleeps).toContain(LARGE_RULESET_RETRY_INITIAL_DELAY_MS);
    expect(sleeps).toContain(600_000);
    expect(logs.some((line) => line.includes('r61-fixture produced no observation'))).toBe(true);
  });

  it('finishes with exit code 0 when r61 is excluded via --exclude-scenario', async () => {
    const selection = selectRtdbScenarios([
      '--scenario',
      'r29-deploy-rejections,r51-deploy-anchor-index-and-length-probes,r61-deploy-regex-3000-groups',
      '--exclude-scenario',
      'r61-deploy-regex-3000-groups',
    ]);
    const order = orderDeployScenarios(selection.deployScenarios);
    const endpoint = createPacedDryRunEndpoint(fakeEndpoint({}), {
      sleep: async () => {},
      log: () => {},
    });
    const written: string[] = [];

    const exitCode = await runCapturePhases({
      earlyDeploys: () =>
        runDeployScenarios(
          endpoint,
          order.beforeOperations,
          { beforeRules: BEFORE_RULES, mountKey: MOUNT_KEY },
          { sleep: async () => {}, log: () => {} },
        ),
      operations: async () => [],
      restoreBeforeLate: async () => {},
      lateDeploys: () =>
        runDeployScenarios(
          endpoint,
          order.afterOperations,
          { beforeRules: BEFORE_RULES, mountKey: MOUNT_KEY },
          { sleep: async () => {}, log: () => {} },
        ),
      restoreAndCleanUp: async () => {},
      assertClean: () => {},
      write: (obs) => {
        written.push(obs.scenario.id);
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(written).toEqual([
      'r29-deploy-rejections',
      'r51-deploy-anchor-index-and-length-probes',
    ]);
  });
});

describe('restoreBeforeLatePhaseWithRetry', () => {
  it('retries transient propagation lag and succeeds when read-back catches up', async () => {
    let reads = 0;
    const sleeps: number[] = [];
    await restoreBeforeLatePhaseWithRetry(
      {
        writeRules: async () => {},
        readRules: async () => {
          reads += 1;
          if (reads === 1) {
            return { ...BEFORE_RULES, staleMount: { '.read': true } };
          }
          return structuredClone(BEFORE_RULES);
        },
      },
      BEFORE_RULES,
      {
        attempts: 3,
        retryDelayMs: 500,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: () => {},
      },
    );

    expect(reads).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('throws when the mismatch persists across all attempts', async () => {
    let writes = 0;
    await expect(
      restoreBeforeLatePhaseWithRetry(
        {
          writeRules: async () => {
            writes += 1;
          },
          readRules: async () => ({ ...BEFORE_RULES, staleMount: { '.read': true } }),
        },
        BEFORE_RULES,
        {
          attempts: 3,
          retryDelayMs: 0,
          sleep: async () => {},
          log: () => {},
        },
      ),
    ).rejects.toThrow(/restore before the late phase did not take/);
    expect(writes).toBe(3);
  });
});
