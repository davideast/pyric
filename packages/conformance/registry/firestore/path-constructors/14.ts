import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["doc","collection","collectionGroup"],
  automation: "oracle-backed",
  behavior: "Unknown or foreign first-argument ref (not produced by this package) passed to `doc`, `collection`, or `collectionGroup` -> `FirebaseError` (`invalid-argument`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-path-constructors-unknown-ref-errors`",
  oracleObservations: ["firestore-path-constructors-unknown-ref-errors"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
