import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'firestore_rules',
  order: 60,
  description:
    'Firestore Security Rules source tooling that runs in the MCP process without a sandbox: lint, simulate against test cases, resolve `2+modules` imports, validate structure, and test on the Rules Test API when project credentials are configured.',
  ops: {
    lint: { transport: 'in-process', factory: 'firestore-rules', handler: 'firestore_lint_rules' },
    simulate: {
      transport: 'in-process',
      factory: 'firestore-rules',
      handler: 'firestore_simulate_rules',
      description:
        'Simulate Firestore security rules locally against a list of test cases. Same shape as this tool\'s `test` operation but in-process — no propagation wait, no side effects. Supports get()/exists() via functionMocks.',
    },
    resolve: {
      transport: 'in-process',
      factory: 'firestore-rules',
      handler: 'rules_resolve_modules',
      fixed: { service: 'firestore' },
      description:
        'Resolve `2+modules` imports in a Firestore Rules source into an ordinary version 2 deployment artifact. The source must declare `service cloud.firestore`. Use for firestore.modules.rules to firestore.rules.',
    },
    validate: { transport: 'in-process', factory: 'firestore-rules', handler: 'firestore_validate_rules' },
    test: { transport: 'in-process', factory: 'firestore-rules', handler: 'firestore_test_rules' },
  },
} as const satisfies ToolRecord;
