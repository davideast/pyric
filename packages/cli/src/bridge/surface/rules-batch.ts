/**
 * Answering many rules requests in one call.
 *
 * Checking a ruleset is a set of questions, not one: whether the owner reads
 * their own order is only meaningful beside whether anyone else does. Asked one
 * call at a time, a single check costs as many calls as it has cases, and the
 * evaluation that motivated this counted a session that spent nineteen calls
 * on one ruleset.
 *
 * So a batch is answered here. Each case gets the same verdict it would get
 * alone, in the order it was sent, and the summary counts the verdicts so the
 * shape of the answer is readable before the cases are.
 */
import { operationFailure } from './context.js';
import { rulesEngineFor } from './rules-engines/registry.js';
import type { RulesRequest } from './rules-engines/types.js';
import type { OperationResult, SurfaceContext } from './types.js';

/** One case's answer, in the order the case was sent. */
interface CaseVerdict {
  operation: string;
  path: string;
  /** Whether the rules allowed it. False for a case the engine could not decide. */
  allowed: boolean;
  /** True when the simulator abstained rather than deciding allow or deny. */
  unsupported?: boolean;
  /** The verdict as the single-case form words it, or why the case was not decided. */
  summary: string;
  data?: unknown;
}

function isUnsupportedOperationResult(result: OperationResult): boolean {
  if (result.data === null || typeof result.data !== 'object') return false;
  const record = result.data as {
    unsupported?: unknown;
    decision?: unknown;
    case?: { decision?: unknown; state?: unknown };
  };
  if (record.unsupported === true) return true;
  if (record.decision === 'UNSUPPORTED') return true;
  if (record.case?.decision === 'UNSUPPORTED' || record.case?.state === 'UNSUPPORTED') {
    return true;
  }
  return false;
}

/** How many of a batch's cases each verdict covers. */
function counted(verdicts: readonly CaseVerdict[]): string {
  let allowed = 0;
  let unsupported = 0;
  for (const verdict of verdicts) {
    if (verdict.unsupported === true) {
      unsupported += 1;
    } else if (verdict.allowed) {
      allowed += 1;
    }
  }
  const denied = verdicts.length - allowed - unsupported;
  const noun = verdicts.length === 1 ? 'case' : 'cases';
  if (unsupported > 0) {
    return `${verdicts.length} ${noun}: ${allowed} allow, ${denied} deny, ${unsupported} unsupported.`;
  }
  return `${verdicts.length} ${noun}: ${allowed} allow, ${denied} deny.`;
}

/** One case's answer, from the engine's own single-case result. */
function verdictOf(request: RulesRequest, result: OperationResult): CaseVerdict {
  const unsupported = isUnsupportedOperationResult(result);
  const allowed =
    !unsupported &&
    result.ok &&
    (result.data as { allowed?: boolean } | undefined)?.allowed === true;
  const verdict: CaseVerdict = {
    operation: request.operation,
    path: request.path,
    allowed,
    summary: result.summary,
  };
  if (unsupported) verdict.unsupported = true;
  if (result.data !== undefined) verdict.data = result.data;
  return verdict;
}

/**
 * Evaluate every case against one service's ruleset and report them together.
 * A case the engine refuses is reported with its refusal rather than dropped,
 * so the answer lines up with the cases that were sent.
 */
export async function simulateCases(
  ctx: SurfaceContext,
  service: string,
  requests: readonly RulesRequest[],
): Promise<OperationResult> {
  if (requests.length === 0) {
    return operationFailure(
      "'cases' must hold at least one case. Pass one case per request to evaluate.",
    );
  }

  const engine = rulesEngineFor(service);
  const verdicts: CaseVerdict[] = [];
  for (const request of requests) {
    verdicts.push(verdictOf(request, await engine.simulate(ctx, request)));
  }

  const hasUnsupported = verdicts.some((verdict) => verdict.unsupported === true);
  return { ok: !hasUnsupported, summary: counted(verdicts), data: { cases: verdicts } };
}
