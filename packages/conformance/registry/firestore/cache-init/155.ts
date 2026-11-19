import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["aggregateFieldEqual", "aggregateQuerySnapshotEqual"],
  api: "aggregateFieldEqual / aggregateQuerySnapshotEqual",
  behavior: "Compares aggregate descriptors and snapshot data for value equality",
  status: "conforms",
  evidence: "`unit:firestore/runtime-classes.test.ts`, oracle: `firestore-refequal-and-aggregate-equality.json`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-refequal-and-aggregate-equality"],
  conformanceTests: ["packages/pyric/test/firestore/runtime-classes.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
