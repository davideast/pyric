/** Check one service's ruleset for errors without evaluating a request. */
import { z } from 'zod';
import { checkDatabaseInstance, instance, RENAMES, service, SERVICES } from '../../arguments/rules.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'lint',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `lint(service: ${SERVICES.join('|')}, rules?, instance?)`,
  description: 'Check a ruleset for errors without evaluating a request.',
  args: z.object({
    service,
    rules: z
      .string()
      .optional()
      .describe('Rules source to lint. Defaults to the rules the sandbox is running.'),
    instance,
  }),
  operation: {
    ids: ['lint_firestore_rules', 'lint_database_rules', 'lint_storage_rules'],
    select: (args) => `lint_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore' },
  validate: (args, { fail }) => checkDatabaseInstance(args, fail),
  async handler(args, ctx) {
    const rules = args.rules === undefined ? undefined : String(args.rules);
    const targetInstance = args.instance === undefined ? undefined : String(args.instance);
    return rulesEngineFor(String(args.service)).lint(ctx, rules, targetInstance);
  },
} satisfies MethodRecord;
