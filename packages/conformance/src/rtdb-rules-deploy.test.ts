/**
 * One deploy scenario's dry runs against a fake rules endpoint: the verdicts
 * recorded, the read-back check, the repeat policy, and the single-attempt
 * policy a large-ruleset scenario such as r61 declares.
 */
import { describe, expect, it } from 'bun:test';
import {
  DRY_RUN_ATTEMPTS,
  DryRunUnanswered,
  captureDeployScenario,
  dryRunPolicyOf,
  normalizeDeployError,
  type RulesDeployEndpoint,
} from './rtdb-rules-deploy.ts';
import { BEFORE_RULES, MOUNT_KEY, SINGLE_ATTEMPT, deployScenario, fakeEndpoint } from './rtdb-rules-deploy-fakes.ts';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS, type RtdbDeployScenario } from '../rules-corpus/rtdb/index.ts';

const capture = (endpoint: RulesDeployEndpoint, scenario: RtdbDeployScenario = deployScenario()) =>
  captureDeployScenario(endpoint, { beforeRules: BEFORE_RULES, mountKey: MOUNT_KEY, scenario });

describe('rtdb-rules deploy scenario capture', () => {
  it('dry-runs each case merged under the mount and records the rejection text', async () => {
    const endpoint = fakeEndpoint({
      reject: (rules) => {
        const mounted = (rules[MOUNT_KEY] as Record<string, { a: Record<string, unknown> }>)['deploy-fixture']!;
        return mounted.a['.valdiate'] ? `/${MOUNT_KEY}/deploy-fixture/a: Invalid key: .valdiate` : undefined;
      },
    });
    expect(await capture(endpoint)).toEqual({
      'unknown rule key': { verdict: 'REJECTED', error: '/<mount>/deploy-fixture/a: Invalid key: .valdiate' },
      'valid ruleset': { verdict: 'ACCEPTED' },
    });
    // The existing rules travel with every dry run, so an endpoint that
    // ignored the flag would still keep them.
    for (const rules of endpoint.sent) {
      expect(rules.app).toEqual(BEFORE_RULES.app);
    }
  });

  it('fails when the live rules differ from the snapshot after a dry run', async () => {
    await expect(capture(fakeEndpoint({ dryRunDeploys: true }))).rejects.toThrow(/live rules changed after the dry run/);
  });

  it('fails on a status that is neither acceptance nor a rules rejection', async () => {
    await expect(capture(fakeEndpoint({ failStatus: 500 }))).rejects.toThrow(/dry run returned 500/);
  });

  it('repeats a dry run that returned a transient 500 and records the next answer', async () => {
    const endpoint = fakeEndpoint({ failStatus: 500, failTimes: 1 });
    expect(await capture(endpoint)).toEqual({
      'unknown rule key': { verdict: 'ACCEPTED' },
      'valid ruleset': { verdict: 'ACCEPTED' },
    });
    expect(endpoint.sent).toHaveLength(3);
  });

  it("gives a large-ruleset scenario's dry runs its own request limit and other scenarios the default", async () => {
    const large = fakeEndpoint({});
    await capture(large, deployScenario('slow', { timeoutMs: 120_000 }));
    expect(large.timeouts).toEqual([120_000, 120_000]);
    const ordinary = fakeEndpoint({});
    await capture(ordinary);
    expect(ordinary.timeouts).toEqual([undefined, undefined]);
  });

  it('repeats a dry run whose request timed out', async () => {
    const endpoint = fakeEndpoint({ timeoutTimes: 1 });
    expect(Object.keys(await capture(endpoint))).toHaveLength(2);
    expect(endpoint.sent).toHaveLength(3);
  });

  it('throws DryRunUnanswered when every attempt timed out', async () => {
    const endpoint = fakeEndpoint({ timeoutTimes: DRY_RUN_ATTEMPTS });
    const failure = capture(endpoint);
    await expect(failure).rejects.toBeInstanceOf(DryRunUnanswered);
    await expect(failure).rejects.toThrow(/timed out/);
    expect(endpoint.sent).toHaveLength(DRY_RUN_ATTEMPTS);
  });

  it('gives up after DRY_RUN_ATTEMPTS server errors in a row', async () => {
    const endpoint = fakeEndpoint({ failStatus: 500 });
    await expect(capture(endpoint)).rejects.toThrow(/dry run returned 500/);
    expect(endpoint.sent).toHaveLength(DRY_RUN_ATTEMPTS);
  });

  it('replaces every occurrence of the mount key in an error text', () => {
    expect(normalizeDeployError(`/${MOUNT_KEY}/a and /${MOUNT_KEY}/b`, MOUNT_KEY)).toBe('/<mount>/a and /<mount>/b');
  });

  it('drops the line:column prefix, which points into the merged dry-run body', () => {
    expect(normalizeDeployError("1:20775: Unknown variable 'foo'.\n", MOUNT_KEY)).toBe("Unknown variable 'foo'.");
  });
});

describe('rtdb-rules single-attempt dry runs', () => {
  it('sends a timed-out dry run once and names the scenario, case and limit', async () => {
    const endpoint = fakeEndpoint({ timeoutTimes: 1 });
    const failure = capture(endpoint, deployScenario('slow-single', SINGLE_ATTEMPT));
    await expect(failure).rejects.toMatchObject({
      scenarioId: 'slow-single',
      caseDescription: 'unknown rule key',
      timeoutMs: 300_000,
    });
    expect(endpoint.sent).toHaveLength(1);
    expect(endpoint.timeouts).toEqual([300_000]);
  });

  it('does not repeat a 5xx either', async () => {
    const endpoint = fakeEndpoint({ failStatus: 500, failTimes: 1 });
    await expect(capture(endpoint, deployScenario('slow-single', SINGLE_ATTEMPT))).rejects.toThrow(/dry run returned 500/);
    expect(endpoint.sent).toHaveLength(1);
  });

  it('records the verdicts when production answers in time', async () => {
    const endpoint = fakeEndpoint({});
    expect(Object.keys(await capture(endpoint, deployScenario('slow-single', SINGLE_ATTEMPT)))).toHaveLength(2);
    expect(endpoint.sent).toHaveLength(2);
  });
});

describe('rtdb-rules dry-run policy in the corpus', () => {
  const corpusScenario = (id: string) => ALL_RULES_RTDB_DEPLOY_SCENARIOS.find((scenario) => scenario.id === id)!;

  it('sends r61 once with a 300s limit and a 10 minute cool-down when production does not answer', () => {
    const r61 = corpusScenario('r61-deploy-regex-3000-groups');
    expect(dryRunPolicyOf(r61)).toEqual({ attempts: 1, timeoutMs: 300_000 });
    expect(r61.largeRuleset?.noAnswer).toEqual({ cooldownMs: 600_000 });
  });

  it('keeps r51 at the default attempts with a 120s limit, failing the run on no answer', () => {
    const r51 = corpusScenario('r51-deploy-anchor-index-and-length-probes');
    expect(dryRunPolicyOf(r51)).toEqual({ attempts: DRY_RUN_ATTEMPTS, timeoutMs: 120_000 });
    expect(r51.largeRuleset?.noAnswer).toBeUndefined();
  });

  it('leaves every other deploy scenario at the default attempts and request limit', () => {
    const ordinary = ALL_RULES_RTDB_DEPLOY_SCENARIOS.filter((scenario) => !scenario.largeRuleset);
    expect(ordinary.length).toBeGreaterThan(0);
    for (const scenario of ordinary) {
      expect(dryRunPolicyOf(scenario)).toEqual({ attempts: DRY_RUN_ATTEMPTS, timeoutMs: undefined });
    }
  });
});
