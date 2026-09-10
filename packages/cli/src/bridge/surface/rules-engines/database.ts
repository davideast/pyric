/** The Realtime Database rules engine behind the `rules` tool. */
import { rtdbRules } from 'pyric/rules';
import type { RtdbCase, RtdbRulesJson } from 'pyric/rules';
import { getClock } from 'pyric/sandbox';
import { getActiveRules, setRules, snapshotState } from 'pyric/sandbox/database';
import { callSandboxTool, operationFailure } from '../context.js';
import type { SurfaceContext } from '../types.js';
import type { RulesEngine, RulesRequest, RulesSourceProblem } from './types.js';

/**
 * The instant `now` evaluates at: the caller's `requestTime`, parsed to epoch
 * milliseconds, or the sandbox clock's own current instant when the call
 * named none.
 */
function nowFor(ctx: SurfaceContext, requestTime: string | undefined): number {
  if (requestTime !== undefined) return Date.parse(requestTime);
  return getClock(ctx.sandbox).now();
}

/** The ruleset a source describes, or null when it is not JSON. */
function parseRuleset(source: string): RtdbRulesJson | null {
  try {
    return JSON.parse(source) as RtdbRulesJson;
  } catch {
    return null;
  }
}

/** The identity a simulation runs as, in the shape the database tools take. */
function identityFor(
  ctx: SurfaceContext,
  uid: string | undefined,
): { uid: string; claims: Record<string, unknown> } | null {
  if (uid !== undefined) {
    const projected = ctx.identity.projectionFor(uid);
    return { uid: projected.uid, claims: projected.token };
  }
  const held = ctx.identity.authState();
  if (held === null) return null;
  return { uid: held.uid, claims: held.token ?? {} };
}

/** The rules engine addresses the tree from the root, whether the caller wrote the separator or not. */
function rooted(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** Evaluate one case against a supplied ruleset rather than the running one. */
function simulateAgainst(
  ctx: SurfaceContext,
  ruleset: RtdbRulesJson,
  request: RulesRequest,
  auth: { uid: string; claims: Record<string, unknown> } | null,
) {
  const tree = snapshotState(ctx.sandbox);
  let data: Record<string, unknown> = {};
  if (tree !== null && typeof tree === 'object') data = tree as Record<string, unknown>;
  let identity: RtdbCase['auth'] = null;
  if (auth !== null) identity = { uid: auth.uid, token: auth.claims };

  const oneCase: RtdbCase = {
    expectation: 'ALLOW',
    operation: request.operation as RtdbCase['operation'],
    path: rooted(request.path),
    auth: identity,
    data,
    now: nowFor(ctx, request.requestTime),
  };
  if (request.data !== undefined) oneCase.newData = request.data;
  return rtdbRules(ruleset).simulate([oneCase]).cases[0];
}

export const DATABASE_RULES: RulesEngine = {
  requestMethods: ['read', 'write', 'validate'],

  parseFailure(source): RulesSourceProblem | null {
    try {
      JSON.parse(source);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        body: `rules did not parse as JSON: ${message}.`,
        fix: 'Pass rules JSON that parses, then call set again.',
      };
    }
  },

  async lint(ctx, rules) {
    let ruleset: RtdbRulesJson | null = null;
    if (rules === undefined) {
      ruleset = getActiveRules(ctx.sandbox);
    } else {
      ruleset = parseRuleset(rules);
      if (ruleset === null) {
        return operationFailure('The supplied database rules are not valid JSON.');
      }
    }
    if (ruleset === null) {
      return operationFailure(
        'No database rules were supplied and none are loaded in the sandbox.',
      );
    }
    const issues = rtdbRules(ruleset).lint();
    const errors = issues.filter((issue) => issue.severity === 'error').length;
    return {
      ok: true,
      summary: `${issues.length} findings, ${errors} errors`,
      data: { issues },
    };
  },

  async simulate(ctx, request) {
    const auth = identityFor(ctx, request.uid);
    const path = rooted(request.path);

    if (request.rules === undefined) {
      const call: Record<string, unknown> = {
        operation: request.operation,
        path,
        auth,
        now: nowFor(ctx, request.requestTime),
      };
      if (request.data !== undefined) call.newData = request.data;
      return callSandboxTool(ctx, 'rtdb_simulate_access', call);
    }

    const ruleset = parseRuleset(request.rules);
    if (ruleset === null) {
      return operationFailure('The supplied database rules are not valid JSON.');
    }
    const evaluated = simulateAgainst(ctx, ruleset, request, auth);
    return {
      ok: !evaluated.unsupported,
      summary: `${request.operation} ${request.path}: ${evaluated.decision}`,
      data: {
        decision: evaluated.decision,
        allowed: evaluated.decision === 'ALLOW',
        matchedPath: evaluated.matchedPath,
        reason: evaluated.reason,
      },
    };
  },

  async install(ctx, rules) {
    const ruleset = parseRuleset(rules);
    if (ruleset === null) {
      return operationFailure(
        'Database rules did not parse. Pass rules JSON that parses, then call set again.',
      );
    }
    setRules(ctx.sandbox, ruleset);
    return { ok: true, summary: 'Database rules installed.' };
  },
};
