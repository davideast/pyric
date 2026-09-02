import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'database_data',
  order: 40,
  description:
    'Realtime Database state in the connected sandbox: read, write, query, and seed the tree, or describe its structure without returning leaf values. Every op runs as admin and bypasses rules unless `as` names a user, in which case rules are enforced for that user.',
  ops: {
    crawl: { transport: 'forwarded', factory: 'rtdb-inspection', handler: 'rtdb_crawl_structure' },
    get: { transport: 'forwarded', factory: 'database-data', handler: 'database_get' },
    set: { transport: 'forwarded', factory: 'database-data', handler: 'database_set' },
    update: { transport: 'forwarded', factory: 'database-data', handler: 'database_update' },
    remove: { transport: 'forwarded', factory: 'database-data', handler: 'database_remove' },
    push: { transport: 'forwarded', factory: 'database-data', handler: 'database_push' },
    transaction: { transport: 'forwarded', factory: 'database-data', handler: 'database_transaction' },
    query: { transport: 'forwarded', factory: 'database-data', handler: 'database_query' },
    seed: { transport: 'forwarded', factory: 'database-data', handler: 'database_seed' },
  },
} as const satisfies ToolRecord;
