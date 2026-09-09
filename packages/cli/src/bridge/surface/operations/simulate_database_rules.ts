/** Evaluate one request against the Realtime Database rules. */
import { z } from 'zod';
import { rtdbRules } from 'pyric/rules';
import type { RtdbCase, RtdbRulesJson } from 'pyric/rules';
import { snapshotState } from 'pyric/sandbox/database';
import { callSandboxTool, operationFailure } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  operation: z.enum(['read', 'write', 'validate']).describe('The access to evaluate.'),
  path: z.string().describe('Root-relative path the request targets.'),
  uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
  data: z.record(z.unknown()).optional().describe('The value being written, read as newData.'),
  rules: z
    .string()
    .optional()
    .describe('Compiled rules.json source. Defaults to the ruleset the sandbox is running.'),
});

export default {
  verb: 'simulate',
  service: 'database',
  object: 'rules',
  description:
    'Evaluate one Realtime Database read, write, or validate against the rules and report the decision.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const auth = identityFor(ctx, input.uid);
    // The rules engine addresses the tree from the root, so a path is rooted
    // here whether or not the caller wrote the leading separator.
    const path = input.path.startsWith('/') ? input.path : `/${input.path}`;

    if (input.rules === undefined) {
      const call: Record<string, unknown> = { operation: input.operation, path, auth };
      if (input.data !== undefined) call.newData = input.data;
      return callSandboxTool(ctx, 'rtdb_simulate_access', call);
    }

    let ruleset: RtdbRulesJson;
    try {
      ruleset = JSON.parse(input.rules) as RtdbRulesJson;
    } catch {
      return operationFailure('The supplied database rules are not valid JSON.');
    }
    const tree = snapshotState(ctx.sandbox);
    const oneCase: RtdbCase = {
      expectation: 'ALLOW',
      operation: input.operation,
      path,
      auth: auth === null ? null : { uid: auth.uid, token: auth.claims },
      data: tree !== null && typeof tree === 'object' ? (tree as Record<string, unknown>) : {},
      ...(input.data !== undefined ? { newData: input.data } : {}),
    };
    const evaluated = rtdbRules(ruleset).simulate([oneCase]).cases[0];
    return {
      ok: !evaluated.unsupported,
      summary: `${input.operation} ${input.path}: ${evaluated.decision}`,
      data: {
        decision: evaluated.decision,
        allowed: evaluated.decision === 'ALLOW',
        matchedPath: evaluated.matchedPath,
        reason: evaluated.reason,
      },
    };
  },
} satisfies OperationRecord;

/** The identity a simulation runs as, in the shape the RTDB tools take. */
function identityFor(
  ctx: Parameters<OperationRecord['handler']>[1],
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
