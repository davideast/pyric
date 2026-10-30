/**
 * Whether one try of a reproduction reproduced its problem. A repro script
 * is a check of the behavior production has:
 *
 * - it exits 1 when the problem shows (pyric did what the report says);
 * - it exits 0 when pyric behaves as production does;
 * - any other exit, a crash before it could tell, or a run stopped at its
 *   limit is inconclusive, never a reproduction.
 *
 * With an expected text (`--expect`), an exit 1 reproduces only when the
 * script's output holds that text, so a script that fails for another
 * reason doesn't confirm the problem.
 *
 * A Google-host problem is judged by the network record alone: it
 * reproduces when the try reached for that host again, whatever the script's
 * exit code, since the sandbox refuses the request either way.
 */
import type { PhaseResult } from './run-phase.ts';
import type { ReproTarget } from './repro-target.ts';

export const PROBLEM_SHOWS_EXIT = 1;
export const BEHAVES_EXIT = 0;

export type TryOutcome = 'reproduced' | 'not-reproduced' | 'inconclusive';

export interface TryEvidence {
  /** How the script ended; null when the phase never said. */
  exit: PhaseResult | null;
  output: string;
  /** Every Google host or metadata address the try reached for. */
  googleHosts: readonly string[];
}

export interface TryJudgment {
  outcome: TryOutcome;
  reason: string;
}

function judgeHost(host: string, evidence: TryEvidence): TryJudgment {
  const reached = evidence.googleHosts.includes(host);
  if (reached) return { outcome: 'reproduced', reason: `the try reached for ${host} again` };
  return { outcome: 'not-reproduced', reason: `the try never reached for ${host}` };
}

function judgeExit(evidence: TryEvidence, expected: string | undefined): TryJudgment {
  const { exit } = evidence;
  if (exit === null) return { outcome: 'inconclusive', reason: 'the phase never said how the script ended' };
  if (exit.timedOut) return { outcome: 'inconclusive', reason: `the script was stopped at its limit after ${Math.round(exit.wallMs / 1000)}s` };
  if (exit.error !== null) return { outcome: 'inconclusive', reason: `the script could not run: ${exit.error}` };
  if (exit.code === BEHAVES_EXIT) return { outcome: 'not-reproduced', reason: 'the script exited 0: pyric behaved as production does' };
  if (exit.code !== PROBLEM_SHOWS_EXIT) return { outcome: 'inconclusive', reason: `the script exited ${exit.code}, neither 0 nor 1` };
  const lacksExpected = expected !== undefined && !evidence.output.includes(expected);
  if (lacksExpected) return { outcome: 'inconclusive', reason: `the script exited 1, but its output does not hold the expected text ${JSON.stringify(expected)}` };
  return { outcome: 'reproduced', reason: expected === undefined ? 'the script exited 1' : 'the script exited 1 with the expected text' };
}

export function judgeTry(target: ReproTarget, evidence: TryEvidence, expected?: string): TryJudgment {
  return target.kind === 'google-host' ? judgeHost(target.host, evidence) : judgeExit(evidence, expected);
}

export type ReproResult = 'reproduced' | 'unconfirmed' | 'inconclusive';

/**
 * A reproduction's result: reproduced when any try did; unconfirmed when a
 * try found pyric behaving as production does; inconclusive when no try could
 * tell either way (each crashed, timed out, or failed to install), which says
 * nothing about pyric.
 */
export function reproResult(outcomes: readonly TryOutcome[]): ReproResult {
  if (outcomes.includes('reproduced')) return 'reproduced';
  if (outcomes.includes('not-reproduced')) return 'unconfirmed';
  return 'inconclusive';
}

/** The command's exit code for each result; 2 stays a refusal before anything ran. */
export const RESULT_EXIT: Record<ReproResult, number> = { reproduced: 0, unconfirmed: 1, inconclusive: 3 };
