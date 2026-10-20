/** Install a ruleset into the running sandbox. */
import { z } from 'zod';
import { checkDatabaseInstance, checkRulesCompile, instance, RENAMES, service, SERVICES } from '../../arguments/rules.js';
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
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: `set(service: ${SERVICES.join('|')}, rules, instance?)`,
  description:
    'Install a ruleset into the running sandbox. The rules must parse for the named service.',
  args: z.object({
    service,
    rules: z.string().describe('Rules source to install.'),
    instance,
  }),
  operation: {
    ids: ['set_firestore_rules', 'set_database_rules', 'set_storage_rules'],
    select: (args) => `set_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore', rules: EXAMPLE_RULES },
  validate: (args, { fail }) => checkDatabaseInstance(args, fail) ?? checkRulesCompile(args, fail),
  async handler(args, ctx) {
    const targetInstance = args.instance === undefined ? undefined : String(args.instance);
    return rulesEngineFor(String(args.service)).install(ctx, String(args.rules), targetInstance);
  },
} satisfies MethodRecord;
