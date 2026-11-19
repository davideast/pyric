import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: [
    'Firestore.batch',
    'WriteBatch.commit',
    'Firestore.runTransaction',
    'Transaction.get',
  ],
  api: 'db.batch() and db.runTransaction(fn, opts)',
  behavior:
    'Commits atomic `WriteBatch` mutations (`create`, `set`, `update`, `delete`, `commit`) and optimistic-concurrency transactions supporting `tx.get(docRef)` and `tx.get(query)` across local and remote arms (translating exhausted retry attempts to `aborted`), but `WriteBatch.commit()` resolves to `undefined` rather than `WriteResult[]`, write `Precondition` options are not modeled, and `Transaction.getAll()` is absent.',
  status: 'diverged-documented',
  statusNote:
    'WriteBatch.commit() resolves to undefined instead of WriteResult[], write Precondition options are not modeled, and Transaction.getAll() is absent',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-batches-and-transactions'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/transaction-query-isolation.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-batches-and-transactions` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `transaction-query-isolation.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['stateful', 'error-code'],
  riskScore: 3,
  riskReasons: ['asserts atomic batch/transaction execution and WriteResult[]/getAll divergences'],
});
