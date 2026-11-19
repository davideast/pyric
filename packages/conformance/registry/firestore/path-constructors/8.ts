import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["doc"],
  automation: "oracle-backed",
  behavior: "`doc(db, 'a', 'b', 'c', 'd')` joins variadic single and multi-segment path arguments and rejects odd total segment counts with `FirebaseError` (`invalid-argument`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-doc-variadic-segments`",
  oracleObservations: ["firestore-doc-variadic-segments"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-path-constructors.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-path-constructors.test.ts"],
});
