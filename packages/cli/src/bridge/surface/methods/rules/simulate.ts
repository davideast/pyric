/**
 * Evaluate requests against one service's ruleset.
 *
 * A call names either one request, through `operation` and `path`, or many,
 * through `cases`. Checking a ruleset is a set of questions rather than one,
 * and asked one call at a time a single check costs as many calls as it has
 * cases.
 */
import { z } from 'zod';
import {
  cases,
  checkOneForm,
  checkOperation,
  data,
  operation,
  path,
  REQUEST_METHODS,
  RENAMES,
  service,
  SERVICES,
  uid,
} from '../../arguments/rules.js';
import { simulateCases } from '../../rules-batch.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';
import type { RulesRequest } from '../../rules-engines/types.js';
import type { Args, MethodRecord } from '../../method-types.js';

/** One case, as the engine's request shape, from either form's fields. */
function requestOf(source: Args, service: string, rules: unknown): RulesRequest {
  const request: RulesRequest = {
    operation: String(source.operation),
    path: String(source.path),
  };
  if (source.uid !== undefined) request.uid = String(source.uid);
  if (rules !== undefined) request.rules = String(rules);
  // Storage rules read the object rather than the payload, and the evaluator
  // takes no write value, so a data argument does not reach that engine.
  if (source.data !== undefined && service !== 'storage') {
    request.data = source.data as Record<string, unknown>;
  }
  return request;
}

export default {
  tool: 'rules',
  method: 'simulate',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `simulate(service: ${SERVICES.join('|')}, operation?: ${REQUEST_METHODS.join('|')}, path?, uid?, data?, cases?, rules?)`,
  description: 'Evaluate one request, or many through cases, and report allow or deny.',
  args: z.object({
    service,
    operation: operation.optional(),
    path: path.optional(),
    uid: uid.optional(),
    data: data.optional(),
    cases,
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
  validate: (args, { fail }) => checkOneForm(args, fail) ?? checkOperation(args, fail),
  async handler(args, ctx) {
    const target = String(args.service);
    if (Array.isArray(args.cases)) {
      const requests = args.cases.map((one) =>
        requestOf(one as Args, target, args.rules),
      );
      return simulateCases(ctx, target, requests);
    }
    return rulesEngineFor(target).simulate(ctx, requestOf(args, target, args.rules));
  },
} satisfies MethodRecord;
