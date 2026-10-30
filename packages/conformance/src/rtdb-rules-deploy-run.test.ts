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

  it('still fails the run when a scenario without a no-answer policy times out', async () => {
    const endpoint = fakeEndpoint({ neverAnswers: new Set(['r51-fixture']) });
    await expect(runDeployScenarios(endpoint, [ORDINARY, LARGE_RETRYING], INPUT, recordingDeps())).rejects.toThrow(
      /r51-fixture .* timed out/,
    );
  });

  it('still fails the run on any other error from a single-attempt scenario', async () => {
    const endpoint = fakeEndpoint({ failStatus: 500 });
    await expect(runDeployScenarios(endpoint, [LARGE_SINGLE], INPUT, recordingDeps())).rejects.toThrow(/returned 500/);
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
