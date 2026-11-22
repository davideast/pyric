/** Check one service's ruleset for errors without evaluating a request. */
import { z } from 'zod';
import { checkDatabaseInstance, instance, RENAMES, service, SERVICES } from '../../arguments/rules.js';
import { checkRulesFirestoreDatabase, databaseArgument } from '../../firestore-database.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'lint',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `lint(service: ${SERVICES.join('|')}, rules?, database?, instance?)`,
  description: 'Check a ruleset for errors without evaluating a request.',
  args: z.object({
    service,
    rules: z
      .string()
      .optional()
      .describe('Rules source to lint. Defaults to the rules the sandbox is running.'),
    database: databaseArgument,
    instance,
  }),
  operation: {
    ids: ['lint_firestore_rules', 'lint_database_rules', 'lint_storage_rules'],
    select: (args) => `lint_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore' },
  validate: (args, { fail }) =>
    checkRulesFirestoreDatabase(args, fail) ?? checkDatabaseInstance(args, fail),
  async handler(args, ctx) {
    const svc = String(args.service);
    let rules: string | undefined;
    if (args.rules !== undefined) {
      rules = String(args.rules);
    }
    let targetSelector: string | undefined;
    if (svc === 'firestore') {
      if (args.database !== undefined) targetSelector = String(args.database);
    } else if (args.instance !== undefined) {
      targetSelector = String(args.instance);
    }
    return rulesEngineFor(svc).lint(ctx, rules, targetSelector);
  },
} satisfies MethodRecord;
