import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: [
    'Firestore.batch',
    'WriteBatch.commit',
    'Firestore.runTransaction',
    'Transaction.get',
    'Transaction.getAll',
  ],
  api: 'db.batch() and db.runTransaction(fn, opts) with Transaction.get / getAll',
  behavior:
    'Commits atomic `WriteBatch` mutations (`create`, `set`, `update`, `delete`, `commit` returning `WriteResult[]` and enforcing write `Precondition` options atomically) and optimistic-concurrency transactions supporting `tx.get(docRef)`, `tx.get(query)`, `tx.getAll(...refsOrReadOptions)`, and write `Precondition` options across local and remote arms (translating exhausted retry attempts to `aborted` and rejecting `tx.getAll` after writes).',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: [
    'firestore-admin-batches-and-transactions',
    'firestore-admin-writeresult-preconditions-filter-getall',
  ],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/writeresult-filter-cursors-getall.test.ts',
    'packages/pyric-admin/test/firestore/transaction-query-isolation.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production captures `firestore-admin-batches-and-transactions` and `firestore-admin-writeresult-preconditions-filter-getall` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `transaction-query-isolation.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['stateful', 'error-code'],
  riskScore: 3,
  riskReasons: ['asserts atomic WriteBatch WriteResult[]/Precondition rollback and Transaction.getAll ordering and read-before-write enforcement'],
});
