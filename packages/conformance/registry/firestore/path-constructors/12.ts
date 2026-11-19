import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["collection"],
  automation: "oracle-backed",
  behavior: "`collection(docRef, name, ...pathSegments)` builds subcollection references anchored at `docRef.path` with `parent` linked to `docRef` and `FirebaseError` (`invalid-argument`) on even relative segment counts",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-collection-from-doc-subcollection`",
  oracleObservations: ["firestore-collection-from-doc-subcollection"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
