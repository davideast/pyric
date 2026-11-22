/** Install a ruleset into the running sandbox. */
import { z } from 'zod';
import { checkDatabaseInstance, checkRulesCompile, instance, RENAMES, service, SERVICES } from '../../arguments/rules.js';
import { checkRulesFirestoreDatabase, databaseArgument } from '../../firestore-database.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';
import type { MethodRecord } from '../../method-types.js';

const EXAMPLE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

export default {
  tool: 'rules',
  method: 'set',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: `set(service: ${SERVICES.join('|')}, rules, database?, instance?)`,
  description:
    'Install a ruleset into the running sandbox. The rules must parse for the named service.',
  args: z.object({
    service,
    rules: z.string().describe('Rules source to install.'),
    database: databaseArgument,
    instance,
  }),
  operation: {
    ids: ['set_firestore_rules', 'set_database_rules', 'set_storage_rules'],
    select: (args) => `set_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore', rules: EXAMPLE_RULES },
  validate: (args, { fail }) =>
    checkRulesFirestoreDatabase(args, fail, undefined, true) ??
    checkDatabaseInstance(args, fail) ??
    checkRulesCompile(args, fail),
  async handler(args, ctx) {
    const svc = String(args.service);
    let targetSelector: string | undefined;
    if (svc === 'firestore') {
      if (args.database !== undefined) targetSelector = String(args.database);
    } else if (args.instance !== undefined) {
      targetSelector = String(args.instance);
    }
    return rulesEngineFor(svc).install(ctx, String(args.rules), targetSelector);
  },
} satisfies MethodRecord;
