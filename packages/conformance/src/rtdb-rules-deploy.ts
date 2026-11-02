/**
 * One rtdb-rules deploy scenario's dry runs. Each case is sent as
 * `PUT /.settings/rules.json?dryRun=true`, which validates the ruleset and
 * deploys nothing, and production's answer is recorded as ACCEPTED or
 * REJECTED with its error text. After each case the live rules are read back
 * and must equal the pre-run snapshot.
 *
 * How often a dry run is repeated, and its request limit, come from the
 * scenario's own `largeRuleset` policy. A dry run production never answers
 * throws `DryRunUnanswered`, so the run can tell it apart from every other
 * failure.
 */
import type { RtdbDeployScenario, RtdbDeployVerdict } from '../rules-corpus/rtdb/index.ts';

/**
 * The two rules-endpoint calls a deploy scenario makes, narrowed so the
 * capture contract can be tested against a fake.
 */
export interface RulesDeployEndpoint {
  /** `PUT /.settings/rules.json?dryRun=true` with `{ rules }`. A `timeoutMs`
   *  limits the request; without one the runtime's default applies. */
  dryRun(rules: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<{ status: number; body: string }>;
  /** The live ruleset's `rules` object. */
  readRules(): Promise<Record<string, unknown>>;
}

/** Attempts per dry run unless the scenario sets its own. Production answers
 *  a large ruleset with an occasional 500 or a timeout that a repeat of the
 *  same body does not. */
export const DRY_RUN_ATTEMPTS = 3;

/** How one scenario's dry runs are sent. */
export interface DryRunPolicy {
  attempts: number;
  /** Each request's limit, or undefined for the runtime's default. */
  timeoutMs: number | undefined;
}

export function dryRunPolicyOf(scenario: RtdbDeployScenario): DryRunPolicy {
  return {
    attempts: scenario.largeRuleset?.attempts ?? DRY_RUN_ATTEMPTS,
    timeoutMs: scenario.largeRuleset?.timeoutMs,
  };
}

/** Every attempt at one case's dry run timed out before production answered. */
export class DryRunUnanswered extends Error {
  readonly scenarioId: string;
  readonly caseDescription: string;
  readonly timeoutMs: number | undefined;

  constructor(scenarioId: string, caseDescription: string, policy: DryRunPolicy, cause: Error) {
    const limit = policy.timeoutMs === undefined ? 'the default limit' : `${policy.timeoutMs / 1_000}s`;
    super(`${scenarioId} :: ${caseDescription}: dry run timed out on all ${policy.attempts} attempt(s), each limited to ${limit}`, { cause });
    this.name = 'DryRunUnanswered';
    this.scenarioId = scenarioId;
    this.caseDescription = caseDescription;
    this.timeoutMs = policy.timeoutMs;
  }
}

/** Stable JSON serialization (sorted keys) for the restore read-back compare —
 *  a structural byte-compare resilient to key ordering / whitespace RTDB may
 *  reformat. */
export function canonicalize(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * The comparable part of a deploy error. The endpoint prefixes its message
 * with `line:column` into the submitted body, which here is the pre-run rules
 * plus the merged subtree, so the position moves with the live rules and is
 * dropped. The run-scoped mount key is replaced, and trailing whitespace trimmed.
 */
export function normalizeDeployError(text: string, mountKey: string): string {
  return text.replaceAll(mountKey, '<mount>').replace(/^\d+:\d+: /, '').trimEnd();
}

function deployErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON; record the body as sent.
  }
  return body;
}

type DryRunResult = Awaited<ReturnType<RulesDeployEndpoint['dryRun']>>;
type DryRunAttempt = DryRunResult | { timedOut: Error };

function isTimeout(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** A dry run answered with a status that a repeat would not change. */
function isFinalAnswer(res: DryRunAttempt): res is DryRunResult {
  return 'status' in res && res.status < 500;
}

/** One dry run, with a request timeout reported as a status-less result. */
async function dryRunOnce(endpoint: RulesDeployEndpoint, rules: Record<string, unknown>, policy: DryRunPolicy): Promise<DryRunAttempt> {
  try {
    return await endpoint.dryRun(rules, { timeoutMs: policy.timeoutMs });
  } catch (error) {
    if (isTimeout(error)) return { timedOut: error };
    throw error;
  }
}

/** Dry-runs `rules` up to `policy.attempts` times, repeating only on a 5xx or
 *  a request timeout. A dry run never changes the live rules, so a repeat
 *  sends the same body with no side effect. */
async function dryRunWithPolicy(endpoint: RulesDeployEndpoint, rules: Record<string, unknown>, policy: DryRunPolicy): Promise<DryRunAttempt> {
  let res = await dryRunOnce(endpoint, rules, policy);
  for (let attempt = 1; attempt < policy.attempts; attempt += 1) {
    if (isFinalAnswer(res)) return res;
    res = await dryRunOnce(endpoint, rules, policy);
  }
  return res;
}

function verdictOf(res: DryRunResult, mountKey: string): RtdbDeployVerdict | undefined {
  if (res.status === 200) return { verdict: 'ACCEPTED' };
  if (res.status === 400) return { verdict: 'REJECTED', error: normalizeDeployError(deployErrorText(res.body), mountKey) };
  return undefined;
}

/**
 * Dry-run every case of a deploy scenario and record production's verdict.
 * Each dry run carries the pre-run rules with the case's subtree merged under
 * `/<mountKey>/<scenario.id>`. After each case the live rules are read back
 * and must equal `beforeRules`; any other outcome throws.
 */
export async function captureDeployScenario(
  endpoint: RulesDeployEndpoint,
  input: { beforeRules: Record<string, unknown>; mountKey: string; scenario: RtdbDeployScenario },
): Promise<Record<string, RtdbDeployVerdict>> {
  const { beforeRules, mountKey, scenario } = input;
  const policy = dryRunPolicyOf(scenario);
  const beforeCanonical = canonicalize(beforeRules);
  const behavior: Record<string, RtdbDeployVerdict> = {};
  for (const deployCase of scenario.deployCases) {
    const label = `${scenario.id} :: ${deployCase.description}`;
    const rules = {
      ...beforeRules,
      [mountKey]: { [scenario.id]: JSON.parse(deployCase.rules) as unknown },
    };
    const res = await dryRunWithPolicy(endpoint, rules, policy);
    if ('timedOut' in res) throw new DryRunUnanswered(scenario.id, deployCase.description, policy, res.timedOut);
    const verdict = verdictOf(res, mountKey);
    if (!verdict) throw new Error(`${label}: dry run returned ${res.status}: ${res.body}`);
    behavior[deployCase.description] = verdict;
    const after = await endpoint.readRules();
    if (canonicalize(after) !== beforeCanonical) {
      throw new Error(`${label}: live rules changed after the dry run`);
    }
  }
  return behavior;
}
