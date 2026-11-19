import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getAggregateFromServer', 'count', 'sum'],
  api: 'getAggregateFromServer(query, { n: count(), s: sum(field) })',
  behavior: 'When count() is paired with sum(y), count includes only the docs that have y (3 of 4), as in production. FL-27.',
  evidence: '`oracle:firestore-aggregate-field-semantics` key `countAndSumY`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts 1 specific value(s)'],
  oracleObservations: ['firestore-aggregate-field-semantics'],
  conformanceTests: [`${IN_PAGE}/firestore-aggregate-field-semantics.test.ts`, `${SERVED}/firestore-served-surface.test.ts`],
});
