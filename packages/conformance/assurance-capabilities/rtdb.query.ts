import type { AssuranceCapabilityRecord } from './types.ts';

/** An RTDB read of a QUERY (not a location) is authorized in production against
 *  the query's constraints: a `.read` rule can require an `orderByChild`/
 *  `equalTo` shape, and an unindexed query is rejected outright. An engine that
 *  authorizes the location and then filters locally decides a different question
 *  from the one production decides. */
export const capability: AssuranceCapabilityRecord = {
  service: 'rtdb',
  description: 'Local ordering, bounds, equality, and limits; index enforcement is not modeled.',
  dependencies: [
    { kind: 'construct', id: 'rtdb.rule-kind.read' },
    { kind: 'construct', id: 'rtdb.rule-kind.indexOn' },
    { kind: 'construct', id: 'rtdb.semantic.read-cascade' },
    {
      kind: 'unbacked',
      behavior: 'query constraints (orderBy/startAt/endAt/equalTo/limit) visible to a `.read` expression, and index enforcement rejecting an unindexed query',
      reason:
        'the RTDB language snapshot enumerates no query bindings, so the constraints a production `.read` rule can authorize against are not modeled by any construct, and no registry row adjudicates query-shape authorization',
    },
  ],
};
