/** The Firestore rules engine behind the `rules` tool. */
import { DOCUMENT_PATH_FORM, rulesSourceRejection, type RulesSourceRejection } from 'pyric/rules/internal';
import { installFirestoreRules } from '../firestore-rules-load.js';
import { callSandboxTool, operationFailure } from '../context.js';
import {
  activeFirestoreRules,
  simulateFirestoreCase,
  simulationDetail,
  unmatchedPathReason,
  type SimulationRequest,
} from '../rules-simulation.js';
import { markLintFindings } from '../rules-verdict.js';
import type { RulesEngine, RulesRequest, RulesSourceProblem } from './types.js';

/** The edit a source that does not parse takes, for lint and for install alike. */
const REPARSE_FIX = 'Fix the syntax, then call rules.set with service \'firestore\'.';

/** The edit a source past production's compile limits takes. */
const RECOMPILE_FIX =
  "Bring the ruleset within production's compile limits (call rules.lint for the fix each limit takes), then call rules.set with service 'firestore'.";

/**
 * Why production would not load a source, from the check every rules load
 * path runs: it does not parse, or it is past a compile limit.
 */
function loadFailure(source: string): RulesSourceProblem | null {
  const rejection = rulesSourceRejection(source);
  return rejection === null ? null : problemFor(rejection);
}

/** A rejection in the caller's words, with the edit that fixes it. */
function problemFor(rejection: RulesSourceRejection): RulesSourceProblem {
  return { body: rejection.message, fix: rejection.kind === 'parse' ? REPARSE_FIX : RECOMPILE_FIX };
}

/** What a call has to do when it named no source and the sandbox holds none. */
const NO_RULES_LOADED =
  "No Firestore rules were supplied and none are loaded in the sandbox. Pass rules, or call rules.set with service 'firestore' first.";

/** The simulation case one request describes, under the engine's own types. */
function caseFor(request: RulesRequest): SimulationRequest {
  const simulation: SimulationRequest = {
    operation: request.operation as SimulationRequest['operation'],
    path: request.path,
  };
  if (request.uid !== undefined) simulation.uid = request.uid;
  // The method's validation has already refused a non-object value for this service.
  if (request.data !== undefined) simulation.data = request.data as SimulationRequest['data'];
  if (request.rules !== undefined) simulation.rules = request.rules;
  if (request.requestTime !== undefined) simulation.requestTime = request.requestTime;
  // The method's validation has already refused a query on anything but a list.
  if (request.query !== undefined) simulation.query = request.query as SimulationRequest['query'];
  return simulation;
}

export const FIRESTORE_RULES: RulesEngine = {
  requestMethods: ['get', 'list', 'create', 'update', 'delete'],

  compileFailure(source): RulesSourceProblem | null {
    // Production rejects a ruleset that does not parse, or is past its
    // compile limits, before it evaluates any request, as `firestoreRules()`
    // does.
    return loadFailure(source);
  },

  async lint(ctx, rules) {
    const source = rules ?? activeFirestoreRules(ctx);
    if (source.length === 0) {
      return operationFailure(NO_RULES_LOADED);
    }
    // A source that does not parse has nothing further to lint. A
    // compile-limit rejection is a lint finding, reported with its fix.
    const rejection = rulesSourceRejection(source);
    if (rejection?.kind === 'parse') {
      return markLintFindings(operationFailure(`Firestore ${rejection.message} ${REPARSE_FIX}`));
    }
    return markLintFindings(await callSandboxTool(ctx, 'firestore_lint_rules', { source }));
  },

  async simulate(ctx, request) {
    const outcome = await simulateFirestoreCase(ctx, caseFor(request));
    if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
    const detail = simulationDetail(outcome.result);
    const decision = outcome.allowed ? 'ALLOW' : 'DENY';
    const queryProof = detail?.queryProof as { verdict?: string } | undefined;
    const proofLabel = queryProof?.verdict !== undefined ? ` (queryProof: ${queryProof.verdict})` : '';
    const verdict = `${request.operation} ${request.path}: ${decision}${proofLabel}`;
    const unmatched = unmatchedPathReason(detail);
    const data: Record<string, unknown> = {
      allowed: outcome.allowed,
      auth: outcome.auth,
      case: detail,
      ...(queryProof !== undefined ? { queryProof } : {}),
    };
    if (unmatched === null) {
      return { ok: true, summary: verdict, data };
    }
    data.pathForm = DOCUMENT_PATH_FORM;
    return { ok: true, summary: `${unmatched} ${verdict}`, data };
  },

  async install(ctx, rules) {
    const rejection = installFirestoreRules(ctx.sandbox, rules);
    if (rejection !== null) {
      const problem = problemFor(rejection);
      return operationFailure(`Firestore ${problem.body} ${problem.fix}`);
    }
    return { ok: true, summary: 'Firestore rules installed.' };
  },
};

/** Trace why one Firestore request was denied, rule by rule. */
export async function explainFirestoreDenial(
  ctx: Parameters<RulesEngine['simulate']>[0],
  request: RulesRequest,
) {
  const outcome = await simulateFirestoreCase(ctx, caseFor(request));
  if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
  const detail = simulationDetail(outcome.result);
  const queryProof = detail?.queryProof as { verdict?: string } | undefined;
  const verdict = outcome.allowed ? 'allowed' : 'denied';
  const proofSuffix = queryProof?.verdict !== undefined ? ` (queryProof: ${queryProof.verdict})` : '';
  return {
    ok: true,
    summary: `${request.operation} ${request.path} is ${verdict} for this identity.${proofSuffix}`,
    data: {
      allowed: outcome.allowed,
      auth: outcome.auth,
      case: detail,
      ...(queryProof !== undefined ? { queryProof } : {}),
    },
  };
}
