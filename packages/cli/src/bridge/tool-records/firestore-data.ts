import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'firestore_data',
  order: 20,
  description:
    'Firestore documents in the connected sandbox: read, write, query, and batch. Every op runs as admin and bypasses rules unless `as` names a user, in which case rules are enforced for that user.',
  ops: {
    get: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_get_document' },
    list: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_list_documents' },
    set: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_create_document' },
    add: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_add_document' },
    update: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_update_document' },
    delete: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_delete_document' },
    batch_write: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_batch_write' },
    query: { transport: 'forwarded', factory: 'firestore-data', handler: 'firestore_query_where' },
  },
} as const satisfies ToolRecord;
