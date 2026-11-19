import { row, adminCaptureTests } from './section.ts';

export default row({
  order: 30,
  featureKeys: [
    'Reference.set',
    'Reference.update',
    'Reference.remove',
    'Reference.push',
    'ServerValue',
  ],
  api: 'ref.set / update / remove / push and ServerValue.TIMESTAMP / ServerValue.increment(delta)',
  behavior:
  'Executes admin writes, multi-path atomic updates (including array `update()` index coercion), removals, chronologically ordered `push()` keys, `onComplete` callbacks, `ServerValue` sentinels, and synchronous payload/key validation matching `firebase-admin` 13.10.0 error text across local and remote arms.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-admin-writes-sentinels-and-validation'],
  conformanceTests: [
    'packages/pyric-admin/test/database/write-validation.test.ts',
    'packages/pyric-admin/test/database/sentinels-and-callbacks.test.ts',
    'packages/pyric-admin/test/database/shared-backend-parity.test.ts',
    ...adminCaptureTests,
  ],
  evidence:
  'Production capture `rtdb-modular-admin-writes-sentinels-and-validation` records `set`, multi-path and array `update`, `remove`, ordered 20-char `push` keys, `onComplete` callbacks, `ServerValue.TIMESTAMP` / `increment`, and synchronous validation throws; replayed verbatim across in-process, SharedWorker, and Node host arms.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts synchronous write validation and ServerValue sentinel resolution'],
});
