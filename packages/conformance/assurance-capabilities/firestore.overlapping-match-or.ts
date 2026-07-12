import type { AssuranceCapabilityRecord } from './types.ts';

/** Production composes EVERY matching allow block with OR: one permissive block
 *  anywhere in the ruleset allows the request, whatever the other matching
 *  blocks say. A simulator that resolves only one block can report DENY where
 *  production ALLOWs — the exact direction that turns a real authorization gap
 *  into a false "no counterexample". */
export const capability: AssuranceCapabilityRecord = {
  service: 'firestore',
  description: 'Multiple matching allow blocks with production OR composition.',
  dependencies: [
    { kind: 'construct', id: 'firestore.semantic.hierarchical-match-cascade' },
    { kind: 'construct', id: 'firestore.rule-kind.match' },
    {
      kind: 'unbacked',
      behavior: 'OR composition across multiple allow-bearing match blocks that match the same path',
      reason:
        'the language snapshot enumerates the hierarchical-match cascade (parent/child nesting) but has no construct for multi-block OR composition, and no rules-engine registry row adjudicates it against the production Rules Test API',
    },
  ],
};
