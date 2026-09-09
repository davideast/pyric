/**
 * Scoring. Turns one finished process plus its event log and final sandbox
 * state into the single result line the reporter aggregates.
 *
 * Nothing here reads the CLI's stdout. The agent's own narration is captured
 * for a human to read and is never evidence: the only evidence is what the
 * server logged and what the sandbox holds.
 */
import type { EvalOutcome, EvalResultLine, EvalRun, EvalState } from './types.js';

/** How the spawned process ended, before the task's own assertion is consulted. */
export type SpawnOutcome = 'completed' | 'timeout' | 'throttled' | 'crash';

export interface ScoreInput {
  run: EvalRun;
  spawn: SpawnOutcome;
  durationMs: number;
  state: EvalState;
}

/**
 * The first canonical operation the agent reached for. Calls that never
 * resolved to an operation are skipped rather than counted as the choice: an
 * unresolvable name says the surface was not understood, which the argument
 * validity and completion numbers already carry.
 */
function firstOperationOf(state: EvalState): string | null {
  for (const call of state.calls) {
    if (call.operation !== null) return call.operation;
  }
  return null;
}

/** An empty accepted set means the task does not constrain the opening move. */
function isFirstOperationAccepted(accepted: string[], firstOperation: string | null): boolean {
  if (accepted.length === 0) return true;
  if (firstOperation === null) return false;
  return accepted.includes(firstOperation);
}

/** A process that did not finish is never scored against the task's assertion. */
function isScorable(spawn: SpawnOutcome): boolean {
  return spawn === 'completed';
}

export function scoreRun(input: ScoreInput): EvalResultLine {
  const { run, state } = input;
  const firstOperation = firstOperationOf(state);
  const callCount = state.calls.length;
  const schemaRejections = state.calls.filter((call) => call.schemaRejected).length;
  const errorCalls = state.calls.filter((call) => !call.ok).length;

  let outcome: EvalOutcome = input.spawn as EvalOutcome;
  let assertReason: string | null = null;
  if (isScorable(input.spawn)) {
    const verdict = run.task.assert(state);
    if (verdict === true) {
      outcome = 'pass';
    } else {
      outcome = 'fail';
      assertReason = verdict;
    }
  }

  return {
    runId: run.runId,
    row: run.row.id,
    variant: run.variant,
    task: run.task.id,
    seed: run.seed,
    outcome,
    firstOperation,
    firstOperationAccepted: isFirstOperationAccepted(
      run.task.acceptedFirstOperations,
      firstOperation,
    ),
    callCount,
    schemaRejections,
    errorCalls,
    durationMs: input.durationMs,
    assertReason,
  };
}
