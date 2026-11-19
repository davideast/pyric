import { row } from './section.ts';

export default row({
  order: 40,
  automation: "oracle-backed",
  behavior: "Passing both `merge` and `mergeFields`: `{ merge: true, mergeFields }` applies `merge: true` (short-circuiting `mergeFields`), whereas `{ merge: false, mergeFields }` applies `mergeFields` (matching `firebase/firestore` `parseSetData` order)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-setdoc-both-merge-and-mergefields`",
  oracleObservations: ["firestore-setdoc-both-merge-and-mergefields"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-setdoc.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-setdoc.test.ts"],
});
