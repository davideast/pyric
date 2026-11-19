import { row, adminCaptureTests } from './section.ts';

export default row({
  order: 70,
  featureKeys: ['Reference.setPriority', 'Reference.setWithPriority'],
  api: 'ref.setPriority(priority, onComplete) / ref.setWithPriority(newVal, newPriority, onComplete?) and inline .priority',
  behavior:
  'Executes `Reference#setPriority` and `Reference#setWithPriority` with `onComplete` callbacks, preserves inline `.priority` and `.value` metadata in `set()` and `update()` for `DataSnapshot#getPriority()`, `exportVal()`, and `orderByPriority()`, rejects non-null `setPriority` on absent nodes with `INVALID_PARAMETERS: could not set priority on non-existent node`, and validates priorities synchronously across local and remote arms.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-admin-priorities-and-inline-priority'],
  conformanceTests: [
    'packages/pyric-admin/test/database/write-validation.test.ts',
    ...adminCaptureTests,
  ],
  evidence:
  'Production capture `rtdb-modular-admin-priorities-and-inline-priority` records `setWithPriority`, `setPriority`, absent-node `INVALID_PARAMETERS` rejection, inline `.priority` / `.value` in `set()` and `update()`, `orderByPriority()` ordering, and synchronous priority validation throws; replayed verbatim across in-process, SharedWorker, and Node host arms.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts priority persistence, absent-node INVALID_PARAMETERS, and priority validation'],
});
