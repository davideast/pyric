/**
 * The order of one rtdb-rules capture, separate from the calls each phase
 * makes so it can be tested against fakes. `capture()` in run-rules-rtdb.ts
 * supplies the phases.
 *
 *   1. Ordinary deploy scenarios, dry runs against the untouched rules.
 *   2. Operation scenarios, which deploy their rules subtree.
 *   3. The restore before the late phase, confirmed by a read-back.
 *   4. Large-ruleset deploy scenarios (r51, r61).
 *   5. The final restore, data cleanup and user cleanup, always.
 *   6. Their checks. Nothing is written unless all of them pass.
 *   7. The writes, then the exit code.
 *
 * A failure in the late phase keeps every observation captured before it,
 * and the run ends non-zero naming the scenario. A failure anywhere before
 * the late phase writes nothing, as before.
 */
import { canonicalize } from './rtdb-rules-deploy.ts';
import { writeCaptureResults, type DeployPhaseResult, type UnansweredScenario } from './rtdb-rules-deploy-run.ts';

/** One scenario's captured verdicts, operation or deploy. */
export interface CapturedObservation {
  scenario: { id: string; fm: string; rationale: string };
  behavior: Record<string, unknown>;
}

export interface CapturePhases {
  earlyDeploys(): Promise<DeployPhaseResult>;
  operations(): Promise<CapturedObservation[]>;
  /** Throws when the restore did not take. */
  restoreBeforeLate(): Promise<void>;
  lateDeploys(): Promise<DeployPhaseResult>;
  /** Restores and cleans up, logging each failure; never throws. */
  restoreAndCleanUp(): Promise<void>;
  /** Throws when the restore or a cleanup could not be verified. */
  assertClean(): void;
  write(observation: CapturedObservation): void;
  log(line: string): void;
}

/** Runs the phases in order and returns the exit code. */
export async function runCapturePhases(phases: CapturePhases): Promise<number> {
  const observations: CapturedObservation[] = [];
  const unanswered: UnansweredScenario[] = [];
  let late: DeployPhaseResult | undefined;
  try {
    const early = await phases.earlyDeploys();
    if (early.failed) throw new Error(`[oracle:rules-rtdb] ${early.failed.id} failed: ${early.failed.reason}`);
    observations.push(...early.observations, ...(await phases.operations()));
    unanswered.push(...early.unanswered);
    await phases.restoreBeforeLate();
    late = await phases.lateDeploys();
    observations.push(...late.observations);
    unanswered.push(...late.unanswered);
  } finally {
    await phases.restoreAndCleanUp();
  }
  phases.assertClean();
  return writeCaptureResults({ observations, unanswered, failed: late?.failed, write: phases.write, log: phases.log });
}

export interface RulesRestoreEndpoint {
  writeRules(rules: Record<string, unknown>): Promise<void>;
  readRules(): Promise<Record<string, unknown>>;
}

/**
 * Write the pre-run rules back and read them back. The late phase's dry runs
 * compare the live rules with the snapshot, and no rules write follows them,
 * so a restore that did not take must stop the run here.
 */
export async function restoreRulesBeforeLatePhase(
  endpoint: RulesRestoreEndpoint,
  beforeRules: Record<string, unknown>,
): Promise<void> {
  await endpoint.writeRules(beforeRules);
  const readBack = await endpoint.readRules();
  const restoreTook = canonicalize(readBack) === canonicalize(beforeRules);
  if (!restoreTook) {
    throw new Error('restore before the late phase did not take: the rules read back differ from the pre-run snapshot');
  }
}
