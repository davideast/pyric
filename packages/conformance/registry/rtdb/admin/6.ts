import { row, adminCaptureTests } from './section.ts';

export default row({
  order: 60,
  featureKeys: [
    'Database.goOffline',
    'Database.goOnline',
    'Reference.onDisconnect',
    'OnDisconnect.set',
    'OnDisconnect.update',
    'OnDisconnect.remove',
    'OnDisconnect.cancel',
  ],
  api: 'db.goOffline() / db.goOnline() and ref.onDisconnect() (set, setWithPriority, update, remove, cancel)',
  behavior:
  'Registers, cancels, and atomically executes queued `OnDisconnect` mutations (`set`, `setWithPriority`, `update`, `remove`, `cancel`) when `goOffline()` disconnects the admin database handle across local and remote arms, with one-shot drain semantics after `goOnline()`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-admin-connection-and-ondisconnect'],
  conformanceTests: [
    'packages/pyric-admin/test/database/on-disconnect-parity.test.ts',
    'packages/pyric-admin/test/database/connection-and-wire-parity.test.ts',
    ...adminCaptureTests,
  ],
  evidence:
  'Production capture `rtdb-modular-admin-connection-and-ondisconnect` records queued `onDisconnect` `set`, `setWithPriority`, multi-path `update`, `remove`, `cancel`, and one-shot drain across `goOffline()` / `goOnline()`; replayed verbatim across in-process, SharedWorker, and Node host arms.',
  risk: ['stateful'],
  riskScore: 3,
  riskReasons: ['asserts disconnect queue execution and cancellation across goOffline/goOnline'],
});
