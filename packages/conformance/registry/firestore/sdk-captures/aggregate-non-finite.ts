import { IN_PAGE, SERVED, row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['sum', 'average'],
  api: 'sum(field) / average(field) over NaN or Infinity',
  behavior: 'sum and average over a field holding NaN return NaN, and over Infinity return Infinity, across in-page, SharedWorker and Node-hosted planes, as in production. FL-28.',
  evidence: '`oracle:firestore-aggregate-field-semantics` keys `nan` and `inf`, replayed in-page and over the SharedWorker and Node-hosted planes.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts 2 specific value(s)'],
  oracleObservations: ['firestore-aggregate-field-semantics'],
  conformanceTests: [`${IN_PAGE}/firestore-aggregate-field-semantics.test.ts`, `${SERVED}/firestore-served-surface.test.ts`],
});
