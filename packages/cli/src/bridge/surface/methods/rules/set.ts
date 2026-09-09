/** Install a ruleset into the running sandbox. */
import { z } from 'zod';
import { checkRulesParse, RENAMES, service } from '../../arguments/rules.js';
import { rulesEngineFor } from '../../rules-engines/index.js';
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
  signature: 'set(service, rules)',
  description:
    'Install a ruleset into the running sandbox. The rules must parse for the named service.',
  args: z.object({
    service,
    rules: z.string().describe('Rules source to install.'),
  }),
  operation: {
    ids: ['set_firestore_rules', 'set_database_rules', 'set_storage_rules'],
    select: (args) => `set_${String(args.service)}_rules`,
  },
  renames: RENAMES,
  example: { service: 'firestore', rules: EXAMPLE_RULES },
  validate: (args, { fail }) => checkRulesParse(args, fail),
  async handler(args, ctx) {
    return rulesEngineFor(String(args.service)).install(ctx, String(args.rules));
  },
} satisfies MethodRecord;
