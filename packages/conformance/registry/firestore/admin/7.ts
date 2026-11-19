import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: [
    'Firestore.collectionGroup',
    'Query.where',
    'Query.orderBy',
    'Query.limit',
    'Query.limitToLast',
  ],
  api: 'Query.where / orderBy / limit / limitToLast / aggregate / collectionGroup and onSnapshot',
  behavior:
    'Filters, orders, limits, aggregates (`count`, `sum`, `average` via `query.aggregate(spec)`), scans collection groups, and streams `QuerySnapshot` / `DocumentSnapshot` updates across local and remote arms; composite `Filter` is deferred and cursor helpers are exposed as `startCursor`/`endCursor` rather than `startAt`/`startAfter`/`endAt`/`endBefore`.',
  status: 'diverged-documented',
  statusNote:
    'Filter is deferred, query.aggregate(spec) resolves directly without .get(), and cursors use startCursor/endCursor rather than startAt/startAfter/endAt/endBefore',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-queries-and-snapshots'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/field-path-queries.test.ts',
    'packages/pyric-admin/test/firestore/firestore/onSnapshot.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-queries-and-snapshots` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `field-path-queries.test.ts`, `onSnapshot.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['listener', 'specific-value'],
  riskScore: 3,
  riskReasons: ['asserts query filtering, ordering, and listener delivery'],
});
