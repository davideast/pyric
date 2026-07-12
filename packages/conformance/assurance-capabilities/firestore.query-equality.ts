import type { AssuranceCapabilityRecord } from './types.ts';

/** A collection query's authorization is proved against the query SHAPE, not
 *  the documents it would return: production evaluates `allow list` with the
 *  query's constraints bound to `request.query` and denies any query the rule
 *  cannot prove is within the caller's allowed set. A probe that reads a
 *  collection therefore rests on the query bindings, not only on `allow list`. */
export const capability: AssuranceCapabilityRecord = {
  service: 'firestore',
  description: 'Collection queries whose rules proof uses the supported equality subset.',
  dependencies: [
    { kind: 'construct', id: 'firestore.rule-kind.allow-list' },
    { kind: 'construct', id: 'firestore.binding.request.query' },
    { kind: 'construct', id: 'firestore.binding.resource.data' },
    { kind: 'construct', id: 'firestore.operator.eq' },
    { kind: 'construct', id: 'firestore.operator.and' },
    { kind: 'registry-row', id: 'firestore-rules#166' },
  ],
};
