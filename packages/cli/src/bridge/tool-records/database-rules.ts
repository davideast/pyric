import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'database_rules',
  order: 50,
  description:
    'Realtime Database rules evaluation against the rules and data currently loaded in the connected sandbox.',
  ops: {
    simulate: { transport: 'forwarded', factory: 'rtdb-inspection', handler: 'rtdb_simulate_access' },
  },
} as const satisfies ToolRecord;
