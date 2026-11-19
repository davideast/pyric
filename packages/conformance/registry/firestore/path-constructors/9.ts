import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["collection"],
  automation: "oracle-backed",
  behavior: "`collection(db, path, ...pathSegments)` returns a tagged `CollectionReference` with `type`, `id`, `path`, `parent` (`null` at root, `DocumentReference` when nested), and `FirebaseError` (`invalid-argument`) on even-segment paths",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-collection-db-path-reference-shape`",
  oracleObservations: ["firestore-collection-db-path-reference-shape"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
