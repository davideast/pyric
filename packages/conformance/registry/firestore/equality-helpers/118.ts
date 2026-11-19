import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["refEqual"],
  behavior: "Cross-flavor `refEqual` via `QuerySnapshot.docs[i].ref` works",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"cross-flavor refEqual via QuerySnapshot doc refs\"), oracle: `firestore-refequal-and-aggregate-equality.json`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-refequal-and-aggregate-equality"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
