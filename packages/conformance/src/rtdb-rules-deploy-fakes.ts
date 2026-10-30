/**
 * Fakes shared by the rtdb-rules deploy tests: a fixture deploy scenario and
 * an in-memory rules endpoint. Nothing here reaches the network.
 */
import type { RulesDeployEndpoint } from './rtdb-rules-deploy.ts';
import type { RtdbDeployScenario, RtdbLargeRulesetPolicy } from '../rules-corpus/rtdb/index.ts';

export const MOUNT_KEY = 'pyric_oracle_rulesrtdb_1752000000000_ab12cd';
export const BEFORE_RULES = { '.read': false, '.write': false, app: { '.read': 'auth != null' } };

export function deployScenario(id = 'deploy-fixture', largeRuleset?: RtdbLargeRulesetPolicy): RtdbDeployScenario {
  return {
    id,
    fm: 'rtdb#71',
    rationale: 'fixture',
    provenance: 'fixture',
    ...(largeRuleset ? { largeRuleset } : {}),
    deployCases: [
      {
        description: 'unknown rule key',
        construct: 'rtdb.rule-kind.unknown-key',
        rules: JSON.stringify({ a: { '.valdiate': 'true' } }),
        expectation: { verdict: 'REJECTED', error: 'x' },
      },
      {
        description: 'valid ruleset',
        construct: 'rtdb.rule-kind.read',
        rules: JSON.stringify({ a: { '.read': 'true' } }),
        expectation: { verdict: 'ACCEPTED' },
      },
    ],
  };
}

export const SINGLE_ATTEMPT: RtdbLargeRulesetPolicy = { timeoutMs: 300_000, attempts: 1, noAnswer: { cooldownMs: 600_000 } };

/** The scenario id a dry-run body mounts under `MOUNT_KEY`. */
export function mountedScenarioId(rules: Record<string, unknown>): string {
  return Object.keys(rules[MOUNT_KEY] as Record<string, unknown>)[0]!;
}

/** A fake rules endpoint. Dry runs never change the live rules unless
 *  `dryRunDeploys` models an endpoint that ignored the dry-run flag. */
export function fakeEndpoint(opts: {
  reject?: (rules: Record<string, unknown>) => string | undefined;
  dryRunDeploys?: boolean;
  failStatus?: number;
  failTimes?: number;
  timeoutTimes?: number;
  /** Every dry run for these scenario ids times out. */
  neverAnswers?: ReadonlySet<string>;
}): RulesDeployEndpoint & { sent: Record<string, unknown>[]; timeouts: Array<number | undefined> } {
  let live: Record<string, unknown> = structuredClone(BEFORE_RULES);
  const sent: Record<string, unknown>[] = [];
  const timeouts: Array<number | undefined> = [];
  const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');
  return {
    sent,
    timeouts,
    async dryRun(rules, options) {
      sent.push(rules);
      timeouts.push(options?.timeoutMs);
      if (opts.neverAnswers?.has(mountedScenarioId(rules))) throw timedOut();
      if (opts.timeoutTimes !== undefined && sent.length <= opts.timeoutTimes) throw timedOut();
      const failsThisCall = opts.failStatus && (opts.failTimes === undefined || sent.length <= opts.failTimes);
      if (failsThisCall) return { status: opts.failStatus!, body: 'internal' };
      const error = opts.reject?.(rules);
      if (error) return { status: 400, body: JSON.stringify({ error }) };
      if (opts.dryRunDeploys) live = structuredClone(rules);
      return { status: 200, body: '' };
    },
    async readRules() {
      return structuredClone(live);
    },
  };
}
