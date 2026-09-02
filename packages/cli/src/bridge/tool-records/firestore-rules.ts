import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'firestore_rules',
  order: 60,
  description:
    'Firestore Security Rules source tooling that runs in the MCP process without a sandbox: lint, simulate against test cases, resolve `2+modules` imports, and validate structure.',
  ops: {
    lint: { transport: 'in-process', factory: 'firestore-rules', handler: 'firestore_lint_rules' },
    simulate: { transport: 'in-process', factory: 'firestore-rules', handler: 'firestore_simulate_rules' },
    resolve: {
      transport: 'in-process',
      factory: 'firestore-rules',
      handler: 'rules_resolve_modules',
      fixed: { service: 'firestore' },
      description:
        'Resolve `2+modules` imports in a Firestore Rules source into an ordinary version 2 deployment artifact. The source must declare `service cloud.firestore`. Use for firestore.modules.rules to firestore.rules.',
    },
    validate: { transport: 'in-process', factory: 'firestore-rules', handler: 'firestore_validate_rules' },
  },
} as const satisfies ToolRecord;
