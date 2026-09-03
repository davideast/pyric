import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 10,
  tools: [
    'firestore_simulator_create',
    'firestore_simulator_execute',
    'firestore_simulator_read',
    'firestore_simulator_batch',
    'firestore_create_with_auto_id',
    'firestore_simulator_undo',
    'firestore_simulator_redo',
    'firestore_simulator_events',
    'firestore_simulator_transaction',
  ],
} as const satisfies ToolFamilyRecord;
