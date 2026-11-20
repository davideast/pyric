import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: [
    'AggregateField',
    'Filter',
    'Firestore.collectionGroup',
    'Query.where',
    'Query.orderBy',
    'Query.limit',
    'Query.limitToLast',
    'Query.aggregate',
    'Query.startAt',
    'Query.startAfter',
    'Query.endAt',
    'Query.endBefore',
  ],
  api: 'Query.where / Filter / orderBy / limit / limitToLast / startAt / startAfter / endAt / endBefore / aggregate(spec).get() / collectionGroup and onSnapshot',
  behavior:
    'Filters (including composite `Filter.where`, `Filter.or`, and `Filter.and` via `Query.where(filter)`), orders, paginates with field-value and `DocumentSnapshot` cursors (`startAt`, `startAfter`, `endAt`, `endBefore`), limits, aggregates (`AggregateField.count/sum/average` via `query.aggregate(spec).get()`), scans collection groups, and streams `QuerySnapshot` / `DocumentSnapshot` updates across local and remote arms.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: [
    'firestore-admin-queries-and-snapshots',
    'firestore-admin-writeresult-preconditions-filter-getall',
  ],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/writeresult-filter-cursors-getall.test.ts',
    'packages/pyric-admin/test/firestore/field-path-queries.test.ts',
    'packages/pyric-admin/test/firestore/firestore/onSnapshot.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production captures `firestore-admin-queries-and-snapshots` and `firestore-admin-writeresult-preconditions-filter-getall` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `field-path-queries.test.ts`, `onSnapshot.test.ts`, `remote-firestore.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['listener', 'specific-value'],
  riskScore: 3,
  riskReasons: ['asserts composite Filter queries, cursors, AggregateQuery.get(), ordering, and listener delivery'],
});
