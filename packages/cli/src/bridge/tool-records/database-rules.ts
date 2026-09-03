import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'database_rules',
  order: 50,
  description:
    'Realtime Database rules tooling: simulate one operation against the data in the connected sandbox using its loaded rules or a supplied rules document, and lint, validate, or generate a rules document in the MCP process.',
  ops: {
    simulate: { transport: 'forwarded', factory: 'rtdb-inspection', handler: 'rtdb_simulate_access' },
    lint: { transport: 'in-process', factory: 'rtdb-rules', handler: 'rtdb_lint_rules' },
    validate: { transport: 'in-process', factory: 'rtdb-rules', handler: 'rtdb_validate_rules' },
    generate: { transport: 'in-process', factory: 'rtdb-rules', handler: 'rtdb_generate_rules' },
  },
} as const satisfies ToolRecord;
