import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 10,
  tools: {
    firestore_simulator_create: 'write',
    firestore_simulator_execute: 'write',
    firestore_simulator_read: 'read',
    firestore_simulator_batch: 'write',
    firestore_create_with_auto_id: 'write',
    firestore_simulator_undo: 'write',
    firestore_simulator_redo: 'write',
    firestore_simulator_events: 'read',
    firestore_simulator_transaction: 'write',
  },
} as const satisfies ToolFamilyRecord;
