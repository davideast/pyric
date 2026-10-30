/**
 * The order and pacing of an rtdb-rules run's deploy scenarios, and what the
 * run does when production never answers one.
 *
 * A scenario with a `largeRuleset` policy (r51, r61) runs after every other
 * scenario. Production is slow to validate those rulesets, and an unanswered
 * dry run leaves the rules endpoint answering 429 for minutes, so nothing
 * else in the run should come after one.
 *
 * A scenario whose policy has `noAnswer` (r61) produces no observation when
 * production does not answer: the run waits out the cool-down, writes every
 * other scenario's observation, names the scenario, and ends non-zero.
 */
import { DryRunUnanswered, captureDeployScenario, type RulesDeployEndpoint } from './rtdb-rules-deploy.ts';
import type { RtdbDeployScenario, RtdbDeployVerdict } from '../rules-corpus/rtdb/index.ts';

/** The pause after each deploy scenario's dry runs, before the next scenario. */
export const DEPLOY_SCENARIO_GAP_MS = 5_000;

/** The pause after a scenario whose dry runs carry very large rulesets. */
export const LARGE_RULESET_GAP_MS = 60_000;

export function deployScenarioGapMs(scenario: RtdbDeployScenario): number {
  return scenario.largeRuleset ? LARGE_RULESET_GAP_MS : DEPLOY_SCENARIO_GAP_MS;
}

/** Deploy scenarios split around the operation scenarios. */
export interface DeployScenarioOrder {
  /** Sent first, against the untouched pre-run rules. */
  beforeOperations: RtdbDeployScenario[];
  /** Sent last, once the operation scenarios' rules are restored. */
  afterOperations: RtdbDeployScenario[];
}

export function orderDeployScenarios(scenarios: readonly RtdbDeployScenario[]): DeployScenarioOrder {
  const isLargeRuleset = (scenario: RtdbDeployScenario) => scenario.largeRuleset !== undefined;
  return {
    beforeOperations: scenarios.filter((scenario) => !isLargeRuleset(scenario)),
    afterOperations: scenarios.filter(isLargeRuleset),
  };
}

export interface DeployRunDeps {
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export const defaultDeployRunDeps: DeployRunDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
};

export interface DeployObservation {
  scenario: RtdbDeployScenario;
  behavior: Record<string, RtdbDeployVerdict>;
}

/** A scenario production did not answer, which has no observation. */
export interface UnansweredScenario {
  id: string;
  timeoutMs: number | undefined;
}

export interface DeployPhaseResult {
  observations: DeployObservation[];
  unanswered: UnansweredScenario[];
}

export function unansweredLine(scenario: UnansweredScenario): string {
  const limit = scenario.timeoutMs === undefined ? 'its request limit' : `${scenario.timeoutMs / 1_000}s`;
  return `[oracle:rules-rtdb] ${scenario.id} produced no observation: production did not answer its dry run within ${limit}.`;
}

function answeredLine(observation: DeployObservation): string {
  const verdicts = Object.values(observation.behavior);
  const rejected = verdicts.filter((v) => v.verdict === 'REJECTED').length;
  const accepted = verdicts.length - rejected;
  return `  ✓ ${observation.scenario.id.padEnd(28)} accepted=${accepted} rejected=${rejected} (dry run; live rules read back unchanged)`;
}

/**
 * Dry-run each scenario in order, pausing after each. A scenario whose policy
 * accepts no answer is recorded as unanswered, followed by its cool-down in
 * place of the pause; every other failure throws.
 */
export async function runDeployScenarios(
  endpoint: RulesDeployEndpoint,
  scenarios: readonly RtdbDeployScenario[],
  input: { beforeRules: Record<string, unknown>; mountKey: string },
  deps: DeployRunDeps = defaultDeployRunDeps,
): Promise<DeployPhaseResult> {
  const result: DeployPhaseResult = { observations: [], unanswered: [] };
  for (const scenario of scenarios) {
    try {
      const behavior = await captureDeployScenario(endpoint, { ...input, scenario });
      const observation = { scenario, behavior };
      result.observations.push(observation);
      deps.log(answeredLine(observation));
      await deps.sleep(deployScenarioGapMs(scenario));
    } catch (error) {
      const noAnswer = scenario.largeRuleset?.noAnswer;
      const isAcceptedNoAnswer = noAnswer !== undefined && error instanceof DryRunUnanswered;
      if (!isAcceptedNoAnswer) throw error;
      const unanswered = { id: scenario.id, timeoutMs: error.timeoutMs };
      result.unanswered.push(unanswered);
      deps.log(`${unansweredLine(unanswered)} Waiting ${noAnswer.cooldownMs / 1_000}s before the next rules call.`);
      await deps.sleep(noAnswer.cooldownMs);
    }
  }
  return result;
}

/**
 * Write every observation, then name each unanswered scenario. Returns the
 * run's exit code: non-zero when any scenario has no observation, so the gap
 * is never silent.
 */
export function writeCaptureResults<T>(input: {
  observations: readonly T[];
  unanswered: readonly UnansweredScenario[];
  write: (observation: T) => void;
  log: (line: string) => void;
}): number {
  for (const observation of input.observations) input.write(observation);
  for (const scenario of input.unanswered) input.log(unansweredLine(scenario));
  const hasUnanswered = input.unanswered.length > 0;
  return hasUnanswered ? 1 : 0;
}
