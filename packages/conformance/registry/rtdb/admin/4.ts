import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['DataSnapshot.val', 'DataSnapshot.forEach', 'DataSnapshot.exportVal'],
  api: 'DataSnapshot (val, exists, child, hasChild, hasChildren, numChildren, forEach, exportVal, toJSON, getPriority)',
  behavior:
  'Coerces dense/sparse integer-keyed objects to arrays in `val()` while preserving string keys in `exportVal()` and `toJSON()`, iterates children in key order with early-exit `forEach`, and clones values defensively across local and remote arms.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-sparse-integer-array-coercion'],
  conformanceTests: [
    'packages/pyric-admin/test/database/array-children.test.ts',
    'packages/pyric-admin/test/database/integer-keys-parity.test.ts',
    'packages/pyric-admin/test/database/snapshot-immutability.test.ts',
    'packages/pyric-admin/test/database/capture-sparse-integer-array-coercion.test.ts',
    'packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts',
  ],
  evidence:
  'Production capture `rtdb-modular-sparse-integer-array-coercion` records `firebase-admin` and modular client `DataSnapshot` sparse array holes, `exportVal()`, `toJSON()`, `getPriority()`, `numChildren()`, and early-exit `forEach()`; replayed verbatim across in-process, SharedWorker, and Node host arms in `capture-sparse-integer-array-coercion.test.ts`, `array-children.test.ts`, `integer-keys-parity.test.ts`, and `snapshot-immutability.test.ts`.',
  risk: ['specific-value'],
  riskScore: 3,
  riskReasons: ['asserts integer-key array coercion, exportVal keys, and child iteration'],
});
