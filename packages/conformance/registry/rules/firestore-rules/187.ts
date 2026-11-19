import { row } from './section.ts';

export default row({
  order: 280,
  featureKeys: [],
  behavior: "Hierarchical nested `match` composition. A child match resolves relative to its parent and grants only the exact nested document path. A recursive wildcard matches zero or more segments: followed by further segments, as in the collection-group shape `match /{path=**}/items/{id}`, it governs every document in a collection with that id at any depth and nothing else, and a match nested in that block matches no request; in the last position, as in `match /{document=**}`, a nested match resolves at any depth below it with the recursive wildcard bound to the longest prefix that lets it match",
  status: "conforms",
  evidence: "`oracle:rules-firestore-hierarchical-match-cascade` captures the exact nested child ALLOW plus parent, sibling, and over-deep DENY controls from the production Firestore Rules Test API, replayed verdict-for-verdict by `packages/pyric/test/rules/oracle-conformance.test.ts`. RECAPTURED, 2026-10-07: the scenario adds 21 production verdicts (11 ALLOW, 10 DENY; 25 in all) for recursive wildcard placement. Under `match /{path=**}/items/{id}`, get and list allow in `items/i1`, `users/u1/items/i1`, `a/b/c/d/items/i1`, `items/i1/items/i2`, and `items/items/items/i3`, and deny in a sibling collection, under an `items` document, and on the parent document. The trailing document wildcard binds the last segment. A match nested in `match /{group=**}/groups/{groupId}` denies at the root and at depth. A match nested in `match /{document=**}` allows at the root and at depth, and in `notes/n1/notes/n2` its document wildcard binds `n2`. `unit:rules/simulator/match-resolution.test.ts` pins the bindings for each placement, and `unit:firestore/collection-group-rules.test.ts` pins direct reads, collection-group queries, and query proof under the collection-group shape through the public SDK.",
  oracleObservations: ["rules-firestore-hierarchical-match-cascade"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/match-resolution.test.ts",
    "packages/pyric/test/firestore/collection-group-rules.test.ts",
  ],
  constructs: ["firestore.semantic.hierarchical-match-cascade"],
});
