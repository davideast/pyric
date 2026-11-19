import { IN_PAGE, captureRow } from './section.ts';

export default captureRow({
  order: 30,
  featureKeys: ['getDocs', 'getAggregateFromServer'],
  api: 'getDocs / getAggregateFromServer on a shape that needs a composite index',
  behavior: 'Production fails a query or multi-field aggregation that needs a missing composite index with `failed-precondition`. Pyric runs it by design; only the served dev chip signals it, and two-range, OR and aggregate shapes get no signal. FL-30.',
  status: 'diverged-documented',
  evidence: '`oracle:firestore-query-composite-index-required` (four shapes and two controls) and `oracle:firestore-aggregate-field-semantics` keys `multi` and `nullField`. Decided 2026-10-27: fix where production is clear; until then this row says they differ.',
  risk: ['error-code'],
  riskScore: 2,
  riskReasons: ['asserts Firebase error code(s): `failed-precondition`'],
  oracleObservations: ['firestore-query-composite-index-required', 'firestore-aggregate-field-semantics'],
  conformanceTests: [`${IN_PAGE}/firestore-query-composite-index-required.test.ts`, `${IN_PAGE}/firestore-aggregate-field-semantics.test.ts`],
});
