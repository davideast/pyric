/** Check one service's ruleset for errors without evaluating a request. */
import { z } from 'zod';
import { checkService, RENAMES, service } from '../../arguments/rules.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'lint',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'lint(service, rules?)',
  description: 'Check a ruleset for errors without evaluating a request.',
  args: z.object({
    service,
    rules: z
      .string()
      .optional()
      .describe('Rules source to lint. Defaults to the rules the sandbox is running.'),
  }),
  operation: {
    ids: ['lint_firestore_rules', 'lint_database_rules', 'lint_storage_rules'],
    select: (args) => `lint_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore' },
  validate: (args, { fail }) => checkService(args, fail),
  async handler(args, ctx) {
    const rules = args.rules === undefined ? undefined : String(args.rules);
    return rulesEngineFor(String(args.service)).lint(ctx, rules);
  },
} satisfies MethodRecord;
