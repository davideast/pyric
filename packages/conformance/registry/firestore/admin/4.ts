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
  api: 'docRef.get() / create(data) / set(data, options?) / update(...) / delete()',
  behavior:
    'Executes chainable document CRUD across local and remote arms (`create` rejects existing documents with `already-exists`, `set` replaces or merges, `update` accepts object maps or field/value pairs and rejects missing documents with `not-found`, and `delete` succeeds idempotently on missing documents), but `create`, `set`, `update`, and `delete` resolve to `undefined` rather than `WriteResult` (`{ writeTime }`), and `Precondition` options on `update`/`delete` are not modeled.',
  status: 'diverged-documented',
  statusNote:
    'create, set, update, and delete resolve to undefined instead of WriteResult ({ writeTime }), and Precondition options on update/delete are not modeled',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-crud-operations'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/firestore/sandbox-ops.test.ts',
    'packages/pyric-admin/test/firestore/firestore/deletedoc-missing.test.ts',
    'packages/pyric-admin/test/firestore/firestore/error-translation.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-crud-operations` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `sandbox-ops.test.ts`, `deletedoc-missing.test.ts`, `error-translation.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts create/update error codes, merge semantics, and void return divergence'],
});
