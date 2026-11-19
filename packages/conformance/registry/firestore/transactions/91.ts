import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Atomic read-write - all reads in `fn` see a consistent snapshot, writes commit together",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts`, `unit:upstream-transform-txn-listener-probes.test.ts`, oracle: `firestore-transaction-and-batch-queued-mutations.json`",
  risk: ["specific-field","atomicity"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-transaction-and-batch-queued-mutations"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/upstream-transform-txn-listener-probes.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
