import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 20,
  tools: {
    firestore_get_document: 'read',
    firestore_list_documents: 'read',
    firestore_create_document: 'write',
    firestore_add_document: 'write',
    firestore_update_document: 'write',
    firestore_delete_document: 'write',
    firestore_batch_write: 'write',
    firestore_query_where: 'read',
  },
} as const satisfies ToolFamilyRecord;
