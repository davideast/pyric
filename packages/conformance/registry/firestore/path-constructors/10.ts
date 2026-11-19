import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["doc","collection"],
  automation: "oracle-backed",
  behavior: "`doc(coll, id, ...pathSegments)` appends relative segments under a `CollectionReference` and rejects even relative segment counts with `FirebaseError` (`invalid-argument`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-doc-from-collection-with-id`",
  oracleObservations: ["firestore-doc-from-collection-with-id"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
