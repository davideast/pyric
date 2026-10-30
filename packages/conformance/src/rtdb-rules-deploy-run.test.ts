/**
 * The order an rtdb-rules run sends its deploy scenarios in, the pauses
 * between them, and what a run does when production never answers a
 * single-attempt scenario such as r61: every other scenario's observation is
 * kept and written, and the run still ends non-zero.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEPLOY_SCENARIO_GAP_MS,
  LARGE_RULESET_GAP_MS,
  deployScenarioGapMs,
  orderDeployScenarios,
  runDeployScenarios,
  writeCaptureResults,
  type DeployRunDeps,
} from './rtdb-rules-deploy-run.ts';
import { BEFORE_RULES, MOUNT_KEY, SINGLE_ATTEMPT, deployScenario, fakeEndpoint } from './rtdb-rules-deploy-fakes.ts';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS } from '../rules-corpus/rtdb/index.ts';

const ORDINARY = deployScenario('r29-fixture');
const LARGE_RETRYING = deployScenario('r51-fixture', { timeoutMs: 120_000 });
const LARGE_SINGLE = deployScenario('r61-fixture', SINGLE_ATTEMPT);

function recordingDeps(): DeployRunDeps & { sleeps: number[]; lines: string[] } {
  const sleeps: number[] = [];
  const lines: string[] = [];
  return {
    sleeps,
    lines,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => {
      lines.push(line);
    },
  };
}

const INPUT = { beforeRules: BEFORE_RULES, mountKey: MOUNT_KEY };

describe('rtdb-rules deploy scenario order', () => {
  it('sends large-ruleset scenarios after the operation scenarios and every other deploy scenario', () => {
    const order = orderDeployScenarios([LARGE_SINGLE, ORDINARY, LARGE_RETRYING]);
    expect(order.beforeOperations.map((s) => s.id)).toEqual(['r29-fixture']);
    expect(order.afterOperations.map((s) => s.id)).toEqual(['r61-fixture', 'r51-fixture']);
  });

  it('puts r51 and r61 last in a full corpus run', () => {
    const order = orderDeployScenarios(ALL_RULES_RTDB_DEPLOY_SCENARIOS);
    expect(order.afterOperations.map((s) => s.id)).toEqual([
      'r51-deploy-anchor-index-and-length-probes',
      'r61-deploy-regex-3000-groups',
    ]);
    expect(order.beforeOperations).toHaveLength(ALL_RULES_RTDB_DEPLOY_SCENARIOS.length - 2);
  });

  it('pauses longer after a large-ruleset scenario', () => {
    expect(deployScenarioGapMs(ORDINARY)).toBe(DEPLOY_SCENARIO_GAP_MS);
    expect(deployScenarioGapMs(LARGE_RETRYING)).toBe(LARGE_RULESET_GAP_MS);
  });
});

describe('rtdb-rules deploy scenarios production does not answer', () => {
  it('keeps every answered observation, names the unanswered scenario, and cools down instead of the gap', async () => {
    const endpoint = fakeEndpoint({ neverAnswers: new Set(['r61-fixture']) });
    const deps = recordingDeps();
    const result = await runDeployScenarios(endpoint, [ORDINARY, LARGE_RETRYING, LARGE_SINGLE], INPUT, deps);

    expect(result.observations.map((o) => o.scenario.id)).toEqual(['r29-fixture', 'r51-fixture']);
    expect(result.unanswered).toEqual([{ id: 'r61-fixture', timeoutMs: 300_000 }]);
    expect(deps.sleeps).toEqual([DEPLOY_SCENARIO_GAP_MS, LARGE_RULESET_GAP_MS, 600_000]);
    expect(deps.lines.some((line) => line.includes('r61-fixture produced no observation'))).toBe(true);
    // One attempt only: a repeat would send the request that sets off the throttling.
    const r61Sends = endpoint.sent.filter((rules) => Object.keys(rules[MOUNT_KEY] as object)[0] === 'r61-fixture');
    expect(r61Sends).toHaveLength(1);
  });

  it('stops at a scenario that times out without a no-answer policy, naming it and keeping what came before', async () => {
    const endpoint = fakeEndpoint({ neverAnswers: new Set(['r51-fixture']) });
    const result = await runDeployScenarios(endpoint, [ORDINARY, LARGE_RETRYING, LARGE_SINGLE], INPUT, recordingDeps());
    expect(result.observations.map((o) => o.scenario.id)).toEqual(['r29-fixture']);
    expect(result.failed).toEqual({ id: 'r51-fixture', reason: expect.stringMatching(/timed out on all 3 attempt/) });
    // Nothing after the failure is sent to an endpoint that may now be throttled.
    expect(endpoint.sent.some((rules) => Object.keys(rules[MOUNT_KEY] as object)[0] === 'r61-fixture')).toBe(false);
  });

  it("records a 5xx on a single-attempt scenario's only try as its failure", async () => {
    const endpoint = fakeEndpoint({ statusFor: new Map([['r61-fixture', 503]]) });
    const result = await runDeployScenarios(endpoint, [LARGE_RETRYING, LARGE_SINGLE], INPUT, recordingDeps());
    expect(result.observations.map((o) => o.scenario.id)).toEqual(['r51-fixture']);
    expect(result.failed).toEqual({ id: 'r61-fixture', reason: expect.stringMatching(/dry run returned 503/) });
    expect(result.unanswered).toEqual([]);
  });

  it('records a 429 that outlasted the back-off cap as the failure', async () => {
    const endpoint = fakeEndpoint({ statusFor: new Map([['r51-fixture', 429]]) });
    const result = await runDeployScenarios(endpoint, [LARGE_RETRYING], INPUT, recordingDeps());
    expect(result.failed).toEqual({ id: 'r51-fixture', reason: expect.stringMatching(/dry run returned 429/) });
  });

  it('reports no failure when every scenario answered', async () => {
    const result = await runDeployScenarios(fakeEndpoint({}), [ORDINARY], INPUT, recordingDeps());
    expect(result.failed).toBeUndefined();
  });
});

describe('rtdb-rules capture results', () => {
  const observation = (id: string) => ({ scenario: deployScenario(id), behavior: {} });

  it('writes every observation, then names each unanswered scenario and ends non-zero', () => {
    const events: string[] = [];
    const exitCode = writeCaptureResults({
      observations: [observation('r29-fixture'), observation('r51-fixture')],
      unanswered: [{ id: 'r61-fixture', timeoutMs: 300_000 }],
      write: (o) => events.push(`write ${o.scenario.id}`),
      log: (line) => events.push(line),
    });
    expect(exitCode).toBe(1);
    expect(events.slice(0, 2)).toEqual(['write r29-fixture', 'write r51-fixture']);
    expect(events.slice(2).join('\n')).toMatch(/r61-fixture produced no observation: production did not answer its dry run within 300s/);
  });

  it('writes every observation, then names the failed scenario and why, and ends non-zero', () => {
    const events: string[] = [];
    const exitCode = writeCaptureResults({
      observations: [observation('r29-fixture')],
      unanswered: [],
      failed: { id: 'r61-fixture', reason: 'r61-fixture :: case: dry run returned 503: forced' },
      write: (o) => events.push(`write ${o.scenario.id}`),
      log: (line) => events.push(line),
    });
    expect(exitCode).toBe(1);
    expect(events[0]).toBe('write r29-fixture');
    expect(events[1]).toMatch(/r61-fixture failed and produced no observation: r61-fixture :: case: dry run returned 503/);
  });

  it('ends zero when every scenario was answered', () => {
    const written: string[] = [];
    const exitCode = writeCaptureResults({
      observations: [observation('r29-fixture')],
      unanswered: [],
      write: (o) => written.push(o.scenario.id),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(written).toEqual(['r29-fixture']);
  });
});
