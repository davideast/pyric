import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`batch.set` / `batch.update` / `batch.delete` queue mutations",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `firestore-transaction-and-batch-queued-mutations.json`",
  risk: ["specific-field","atomicity"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-transaction-and-batch-queued-mutations"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
