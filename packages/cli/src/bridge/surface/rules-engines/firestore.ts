/** The Firestore rules engine behind the `rules` tool. */
import { DOCUMENT_PATH_FORM, rulesSourceRejection, type RulesSourceRejection } from 'pyric/rules/internal';
import { firestoreDatabaseSelector, onFirestoreDatabase } from '../firestore-database.js';
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
  if (rejection === null) return null;
  return problemFor(rejection);
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
  if (request.data !== undefined) simulation.data = request.data as SimulationRequest['data'];
  if (request.rules !== undefined) simulation.rules = request.rules;
  if (request.database !== undefined) simulation.database = request.database;
  if (request.requestTime !== undefined) simulation.requestTime = request.requestTime;
  if (request.query !== undefined) simulation.query = request.query as SimulationRequest['query'];
  return simulation;
}

export const FIRESTORE_RULES: RulesEngine = {
  requestMethods: ['get', 'list', 'create', 'update', 'delete'],

  compileFailure(source): RulesSourceProblem | null {
    return loadFailure(source);
  },

  async lint(ctx, rules, targetDatabase) {
    const selector = firestoreDatabaseSelector(targetDatabase);
    const source = rules ?? activeFirestoreRules(ctx, selector);
    if (source.length === 0) {
      return operationFailure(NO_RULES_LOADED);
    }
    const rejection = rulesSourceRejection(source);
    if (rejection?.kind === 'parse') {
      return markLintFindings(operationFailure(`Firestore ${rejection.message} ${REPARSE_FIX}`));
    }
    const linted = await callSandboxTool(ctx, 'firestore_lint_rules', { source });
    if (selector === undefined) {
      return markLintFindings(linted);
    }
    return markLintFindings({
      ...linted,
      summary: onFirestoreDatabase(linted.summary, selector),
    });
  },

  async simulate(ctx, request) {
    const selector = firestoreDatabaseSelector(request.database);
    const outcome = await simulateFirestoreCase(ctx, caseFor(request));
    if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
    const detail = simulationDetail(outcome.result);
    const decision = outcome.allowed ? 'ALLOW' : 'DENY';
    const queryProof = detail?.queryProof as { verdict?: string } | undefined;
    let proofLabel = '';
    if (queryProof?.verdict !== undefined) {
      proofLabel = ` (queryProof: ${queryProof.verdict})`;
    }
    const verdict = onFirestoreDatabase(
      `${request.operation} ${request.path}: ${decision}${proofLabel}`,
      selector,
    );
    const unmatched = unmatchedPathReason(detail);
    const data: Record<string, unknown> = {
      allowed: outcome.allowed,
      auth: outcome.auth,
      case: detail,
    };
    if (selector !== undefined) {
      data.database = selector;
      data.ruleset = request.rules !== undefined ? 'draft' : `firestore (${selector})`;
    }
    if (queryProof !== undefined) {
      data.queryProof = queryProof;
    }
    if (unmatched === null) {
      return { ok: true, summary: verdict, data };
    }
    data.pathForm = DOCUMENT_PATH_FORM;
    return { ok: true, summary: `${unmatched} ${verdict}`, data };
  },

  async install(ctx, rules, targetDatabase) {
    const selector = firestoreDatabaseSelector(targetDatabase);
    const failure = loadFailure(rules);
    if (failure !== null) {
      return operationFailure(`Firestore ${failure.body} ${failure.fix}`);
    }
    const rejection = installFirestoreRules(ctx.sandbox, rules, selector);
    if (rejection !== null) {
      const problem = problemFor(rejection);
      return operationFailure(`Firestore ${problem.body} ${problem.fix}`);
    }
    if (selector === undefined) {
      return { ok: true, summary: 'Firestore rules installed.' };
    }
    return { ok: true, summary: `Firestore rules installed on ${selector}.` };
  },
};

/** Trace why one Firestore request was denied, rule by rule. */
export async function explainFirestoreDenial(
  ctx: Parameters<RulesEngine['simulate']>[0],
  request: RulesRequest,
) {
  const selector = firestoreDatabaseSelector(request.database);
  const outcome = await simulateFirestoreCase(ctx, caseFor(request));
  if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
  const detail = simulationDetail(outcome.result);
  const queryProof = detail?.queryProof as { verdict?: string } | undefined;
  const verdict = outcome.allowed ? 'allowed' : 'denied';
  let proofSuffix = '';
  if (queryProof?.verdict !== undefined) {
    proofSuffix = ` (queryProof: ${queryProof.verdict})`;
  }
  let summary = `${request.operation} ${request.path} is ${verdict} for this identity.${proofSuffix}`;
  if (selector !== undefined) {
    const rulesetLabel = request.rules !== undefined ? 'draft ruleset' : `active ruleset of ${selector}`;
    summary = `${request.operation} ${request.path} on ${selector} (${rulesetLabel}) is ${verdict} for this identity.${proofSuffix}`;
  }
  const data: Record<string, unknown> = {
    allowed: outcome.allowed,
    auth: outcome.auth,
    case: detail,
  };
  if (selector !== undefined) {
    data.database = selector;
    data.ruleset = request.rules !== undefined ? 'draft' : `firestore (${selector})`;
  }
  if (queryProof !== undefined) {
    data.queryProof = queryProof;
  }
  return {
    ok: true,
    summary,
    data,
  };
}
