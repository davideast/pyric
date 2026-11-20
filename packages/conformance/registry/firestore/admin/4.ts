import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: [
    'DocumentReference.get',
    'DocumentReference.create',
    'DocumentReference.set',
    'DocumentReference.update',
    'DocumentReference.delete',
  ],
  api: 'docRef.get() / create(data) / set(data, options?) / update(...) / delete(precondition?)',
  behavior:
    'Executes chainable document CRUD across local and remote arms (`create` rejects existing documents with `already-exists`, `set` replaces or merges, `update` accepts object maps or field/value pairs and rejects missing documents with `not-found`, `delete` succeeds idempotently on missing documents), returning `WriteResult` (`{ writeTime, isEqual }`) from `create`, `set`, `update`, and `delete` and enforcing `Precondition` (`exists`, `lastUpdateTime`) options on `update` and `delete`.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: [
    'firestore-admin-crud-operations',
    'firestore-admin-writeresult-preconditions-filter-getall',
  ],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/writeresult-filter-cursors-getall.test.ts',
    'packages/pyric-admin/test/firestore/firestore/sandbox-ops.test.ts',
    'packages/pyric-admin/test/firestore/firestore/deletedoc-missing.test.ts',
    'packages/pyric-admin/test/firestore/firestore/error-translation.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production captures `firestore-admin-crud-operations` and `firestore-admin-writeresult-preconditions-filter-getall` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `sandbox-ops.test.ts`, `deletedoc-missing.test.ts`, `error-translation.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts create/update/delete error codes, WriteResult timestamps, and Precondition enforcement'],
});
