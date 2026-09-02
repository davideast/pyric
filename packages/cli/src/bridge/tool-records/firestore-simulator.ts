import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'firestore_simulator',
  order: 10,
  description:
    'Stateful Firestore rules simulator session in the connected sandbox: seed rules and documents, execute writes and reads under rules, batch, transact, undo and redo, and read the event log.',
  ops: {
    create: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_create' },
    execute: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_execute' },
    read: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_read' },
    batch: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_batch' },
    add: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_create_with_auto_id' },
    undo: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_undo' },
    redo: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_redo' },
    events: { transport: 'forwarded', factory: 'firestore-simulator', handler: 'firestore_simulator_events' },
    transaction: {
      transport: 'forwarded',
      factory: 'firestore-simulator',
      handler: 'firestore_simulator_transaction',
    },
  },
} as const satisfies ToolRecord;
