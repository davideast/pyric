/**
 * The two failures that are the surface working, and the next call each one
 * takes.
 *
 * A data-plane call refused by Security Rules and a lint that reports findings
 * both come back as failures, because that is what they are to the caller. But
 * neither is the surface failing: the call reached its handler, the handler
 * ran, and the answer is the one the caller asked for. So each carries a code,
 * which the event log reads to keep them out of the error count, and each
 * carries the sentence naming the call that follows it, because a refusal that
 * does not say what to do next is answered by guessing.
 */
import type { OperationResult } from './types.js';

/** A data-plane call Security Rules refused. */
export const DENIED_BY_RULES_CODE = 'denied_by_rules';

/** A lint that found something in the source it was given. */
export const LINT_FINDINGS_CODE = 'lint_findings';

/** The tools whose calls Security Rules can refuse. */
const RULED_TOOLS: ReadonlySet<string> = new Set(['firestore', 'database', 'storage']);

/** How a refused call reads, whichever service refused it. */
const DENIAL_PHRASES = ['denied by rules', 'permission-denied', 'PERMISSION_DENIED'];

/** Whether a summary is a service reporting that rules refused the call. */
function readsAsDenial(summary: string): boolean {
  return DENIAL_PHRASES.some((phrase) => summary.includes(phrase));
}

/** The call that turns a refusal into the trace explaining it. */
export function explainDenialSentence(service: string): string {
  return `Call rules.explainDenial with service '${service}' for the trace.`;
}

/** One result's data as a record, so a code can be written onto it. */
function dataRecord(result: OperationResult): Record<string, unknown> {
  if (result.data === null || typeof result.data !== 'object') return {};
  return { ...(result.data as Record<string, unknown>) };
}

/**
 * Mark a refused data-plane call as the verdict it is, and say what to call
 * next. A result that is not a refusal is returned unchanged.
 */
export function markDenial(tool: string, result: OperationResult): OperationResult {
  if (result.ok) return result;
  if (!RULED_TOOLS.has(tool)) return result;
  if (!readsAsDenial(result.summary)) return result;
  const data = dataRecord(result);
  if (data.code === DENIED_BY_RULES_CODE) return result;
  data.code = DENIED_BY_RULES_CODE;
  return {
    ok: false,
    summary: `${result.summary} ${explainDenialSentence(tool)}`,
    data,
  };
}

/** Mark a lint result that reports findings as the verdict it is. */
export function markLintFindings(result: OperationResult): OperationResult {
  if (result.ok) return result;
  const data = dataRecord(result);
  data.code = LINT_FINDINGS_CODE;
  return { ok: false, summary: result.summary, data };
}
