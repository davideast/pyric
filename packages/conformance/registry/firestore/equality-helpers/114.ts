import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["refEqual"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`refEqual` is `false` for refs at different paths",
  evidence: "`unit:sandbox-live-identity.test.ts`, oracle: `firestore-refequal-and-aggregate-equality.json`",
  oracleObservations: ["firestore-refequal-and-aggregate-equality"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
