import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 20,
  tools: [
    'firestore_get_document',
    'firestore_list_documents',
    'firestore_create_document',
    'firestore_add_document',
    'firestore_update_document',
    'firestore_delete_document',
    'firestore_batch_write',
    'firestore_query_where',
  ],
} as const satisfies ToolFamilyRecord;
