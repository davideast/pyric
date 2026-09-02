import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'storage_rules',
  order: 80,
  description:
    'Cloud Storage Security Rules source tooling that runs in the MCP process without a sandbox: resolve `2+modules` imports, lint a source, and simulate one request against it.',
  ops: {
    resolve: {
      transport: 'in-process',
      factory: 'firestore-rules',
      handler: 'rules_resolve_modules',
      fixed: { service: 'storage' },
      description:
        'Resolve `2+modules` imports in a Cloud Storage Rules source into an ordinary version 2 deployment artifact. The source must declare `service firebase.storage`. Use for storage.modules.rules to storage.rules.',
    },
    lint: { transport: 'in-process', factory: 'storage-rules', handler: 'storage_lint_rules' },
    simulate: { transport: 'in-process', factory: 'storage-rules', handler: 'storage_simulate_rules' },
  },
} as const satisfies ToolRecord;
