import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["doc"],
  automation: "oracle-backed",
  behavior: "`doc(db, path)` returns a tagged `DocumentReference` with `type`, `id`, normalized `path` (leading/trailing slashes trimmed), `parent` `CollectionReference`, and `FirebaseError` (`invalid-argument`) on empty or odd-segment paths",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-doc-db-path-reference-shape`",
  oracleObservations: ["firestore-doc-db-path-reference-shape"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
