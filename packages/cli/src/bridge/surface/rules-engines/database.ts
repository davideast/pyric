/** The Realtime Database rules engine behind the `rules` tool. */
import { rtdbRules } from 'pyric/rules';
import { locateRtdbTrace } from 'pyric/rules/internal/rtdb';
import type { RtdbCase, RtdbRulesJson } from 'pyric/rules';
import { getActiveRules, setRules, snapshotState } from 'pyric/sandbox/database';
import { parseRtdbRulesText } from '../../../rtdb/rules-json.js';
import { callSandboxTool, operationFailure } from '../context.js';
import { requestInstant } from '../request-instant.js';
import { markLintFindings } from '../rules-verdict.js';
import type { SurfaceContext } from '../types.js';
import type { RulesEngine, RulesRequest, RulesSourceProblem } from './types.js';

/** What a call has to do when it named no source and the sandbox holds none. */
const NO_RULES_LOADED =
  "No database rules were supplied and none are loaded in the sandbox. Pass rules, or call rules.set with service 'database' first.";

/** What a call has to do when the source it named is not the JSON these rules take. */
function notRules(problem: string): string {
  return `The supplied database rules did not parse: ${problem}. Pass rules as a JSON object with a 'rules' key.`;
}

/**
 * The ruleset a source describes, or why it is not a rules document. The
 * source is the text of a rules file, comments included.
 */
function parseRuleset(source: string): { ruleset: RtdbRulesJson } | { problem: string } {
  try {
    return { ruleset: parseRtdbRulesText(source, (reason) => reason) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
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
    now: requestInstant(ctx, request.requestTime),
  };
  if (request.data !== undefined) oneCase.newData = request.data;
  if (request.query !== undefined) oneCase.query = request.query as RtdbCase['query'];
  return rtdbRules(ruleset).simulate([oneCase]).cases[0];
}

export const DATABASE_RULES: RulesEngine = {
  requestMethods: ['read', 'write', 'update', 'validate'],

  compileFailure(source): RulesSourceProblem | null {
    const parsed = parseRuleset(source);
    if ('ruleset' in parsed) return null;
    return {
      body: `rules did not parse: ${parsed.problem}.`,
      fix: "Pass rules JSON with a top-level 'rules' object, then call set again.",
    };
  },

  async lint(ctx, rules) {
    let ruleset: RtdbRulesJson | null = null;
    if (rules === undefined) {
      ruleset = getActiveRules(ctx.sandbox);
    } else {
      const parsed = parseRuleset(rules);
      if ('problem' in parsed) {
        return operationFailure(notRules(parsed.problem));
      }
      ruleset = parsed.ruleset;
    }
    if (ruleset === null) {
      return operationFailure(NO_RULES_LOADED);
    }
    const issues = rtdbRules(ruleset).lint();
    const errors = issues.filter((issue) => issue.severity === 'error').length;
    return markLintFindings({
      ok: errors === 0,
      summary: `${issues.length} findings, ${errors} errors`,
      data: { issues },
    });
  },

  async simulate(ctx, request) {
    const auth = identityFor(ctx, request.uid);
    const path = rooted(request.path);

    if (request.rules === undefined) {
      const call: Record<string, unknown> = {
        operation: request.operation,
        path,
        auth,
        now: requestInstant(ctx, request.requestTime),
      };
      if (request.data !== undefined) call.newData = request.data;
      if (request.query !== undefined) call.query = request.query;
      return callSandboxTool(ctx, 'rtdb_simulate_access', call);
    }

    const parsed = parseRuleset(request.rules);
    if ('problem' in parsed) {
      return operationFailure(notRules(parsed.problem));
    }
    const evaluated = simulateAgainst(ctx, parsed.ruleset, request, auth);
    return {
      ok: !evaluated.unsupported,
      summary: `${request.operation} ${request.path}: ${evaluated.decision}`,
      data: {
        decision: evaluated.decision,
        allowed: evaluated.decision === 'ALLOW',
        matchedPath: evaluated.matchedPath,
        matchedRule: evaluated.matchedRule,
        reason: evaluated.reason,
        trace: locateRtdbTrace(request.rules, evaluated.trace),
      },
    };
  },

  async install(ctx, rules) {
    const parsed = parseRuleset(rules);
    if ('problem' in parsed) {
      return operationFailure(
        `Database rules did not parse: ${parsed.problem}. Pass rules JSON with a top-level 'rules' object, then call set again.`,
      );
    }
    setRules(ctx.sandbox, parsed.ruleset);
    return { ok: true, summary: 'Database rules installed.' };
  },
};
