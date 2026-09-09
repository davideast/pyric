/** The Firestore rules engine behind the `rules` tool. */
import { lintFirestoreRules } from 'pyric/rules/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { callSandboxTool, operationFailure } from '../context.js';
import {
  activeFirestoreRules,
  simulateFirestoreCase,
  simulationDetail,
  type SimulationRequest,
} from '../rules-simulation.js';
import type { RulesEngine, RulesRequest } from './types.js';

/** The simulation case one request describes, under the engine's own types. */
function caseFor(request: RulesRequest): SimulationRequest {
  const simulation: SimulationRequest = {
    operation: request.operation as SimulationRequest['operation'],
    path: request.path,
  };
  if (request.uid !== undefined) simulation.uid = request.uid;
  if (request.data !== undefined) simulation.data = request.data;
  if (request.rules !== undefined) simulation.rules = request.rules;
  return simulation;
}

export const FIRESTORE_RULES: RulesEngine = {
  async lint(ctx, rules) {
    const source = rules ?? activeFirestoreRules(ctx);
    if (source.length === 0) {
      return operationFailure(
        'No Firestore rules were supplied and none are loaded in the sandbox.',
      );
    }
    return callSandboxTool(ctx, 'firestore_lint_rules', { source });
  },

  async simulate(ctx, request) {
    const outcome = await simulateFirestoreCase(ctx, caseFor(request));
    if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
    return {
      ok: true,
      summary: `${request.operation} ${request.path}: ${outcome.allowed ? 'ALLOW' : 'DENY'}`,
      data: {
        allowed: outcome.allowed,
        auth: outcome.auth,
        case: simulationDetail(outcome.result),
      },
    };
  },

  async install(ctx, rules) {
    const lint = lintFirestoreRules(rules);
    if (lint.parseError !== undefined) {
      const error = lint.parseError;
      return operationFailure(
        `Firestore rules did not parse at line ${error.line}, column ${error.column}: expected ${error.expected}. Pass a rules source that parses, then call set again.`,
      );
    }
    setRules(ctx.sandbox, rules);
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
  const verdict = outcome.allowed ? 'allowed' : 'denied';
  return {
    ok: true,
    summary: `${request.operation} ${request.path} is ${verdict} for this identity.`,
    data: {
      allowed: outcome.allowed,
      auth: outcome.auth,
      case: simulationDetail(outcome.result),
    },
  };
}
