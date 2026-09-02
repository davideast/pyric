import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'database_data',
  order: 40,
  description:
    'Realtime Database state in the connected sandbox: describe the tree structure without returning leaf values.',
  ops: {
    crawl: { transport: 'forwarded', factory: 'rtdb-inspection', handler: 'rtdb_crawl_structure' },
  },
} as const satisfies ToolRecord;
