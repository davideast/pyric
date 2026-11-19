import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["doc"],
  automation: "oracle-backed",
  behavior: "`doc(coll)` (no id) mints a 20-character alphanumeric auto-id `DocumentReference` under `coll.path`, while `doc(db)` with no path segments throws `FirebaseError` (`invalid-argument`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-doc-from-collection-autoid`",
  oracleObservations: ["firestore-doc-from-collection-autoid"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
