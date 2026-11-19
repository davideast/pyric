import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["collection","collectionGroup"],
  behavior: "`collectionGroup(db, id)` returns a query spanning every collection with that id; `onSnapshot` on it delivers the initial snapshot and every later write to a collection with that id at any depth",
  evidence: "`unit:sandbox-target.test.ts` (\"gathers documents across every parent collection\"). UPDATED, 2026-10-07: oracle `packages/conformance/observations/firestore/firestore-collection-group-listener.json`, captured with the Web SDK against temporarily deployed production rules that were restored afterwards. Under `match /{path=**}/<id>/{id}`, a listener on `collectionGroup(db, id)` fired once with the existing document, once with `added` for a write in a subcollection with that id, once with `added` for a write in the root collection with that id, and not at all for a write in a sibling collection; a listener on a collection id that only a concrete match governs received `permission-denied`. `unit:firestore/oracle-conformance.test.ts` replays the capture in the sandbox; `unit:firestore/collection-group-rules.test.ts` pins the same sequence, the denial routed to the error callback, and query constraints on the listener; `cli:serve/worker/collection-group-listener.test.ts` pins the same delivery and denial through the worker bridge.",
  automation: "oracle-backed",
  oracleObservations: ["firestore-collection-group-listener"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/collection-group-rules.test.ts", "packages/pyric/test/firestore/oracle-conformance.test.ts", "packages/cli/test/serve/worker/collection-group-listener.test.ts"],
});
