/** Evaluate one request against one service's ruleset. */
import { z } from 'zod';
import { checkOperation, RENAMES, service } from '../../arguments/rules.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';
import type { RulesRequest } from '../../rules-engines/types.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'simulate',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'simulate(service, operation, path, uid?, data?, rules?)',
  description: 'Evaluate one request against a ruleset and report allow or deny.',
  args: z.object({
    service,
    operation: z.string().describe('The request method to evaluate.'),
    path: z.string().describe('The path the request targets.'),
    uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
    data: z.record(z.unknown()).optional().describe('The value being written.'),
    rules: z
      .string()
      .optional()
      .describe('Rules source to evaluate. Defaults to the rules the sandbox is running.'),
  }),
  operation: {
    ids: ['simulate_firestore_rules', 'simulate_database_rules', 'simulate_storage_rules'],
    select: (args) => `simulate_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore', operation: 'get', path: 'users/alice', uid: 'alice' },
  validate: (args, { fail }) => checkOperation(args, fail),
  async handler(args, ctx) {
    const target = String(args.service);
    const request: RulesRequest = {
      operation: String(args.operation),
      path: String(args.path),
    };
    if (args.uid !== undefined) request.uid = String(args.uid);
    if (args.rules !== undefined) request.rules = String(args.rules);
    // Storage rules read the object rather than the payload, and the evaluator
    // takes no write value, so a data argument does not reach that engine.
    if (args.data !== undefined && target !== 'storage') {
      request.data = args.data as Record<string, unknown>;
    }
    return rulesEngineFor(target).simulate(ctx, request);
  },
} satisfies MethodRecord;
