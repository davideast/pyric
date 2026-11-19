import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["average"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`average` returns `null` (while `sum` returns `0`) on empty collections, zero-match filters, missing-field docs, and non-numeric field values",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-aggregate-average-empty-and-nonnumeric`",
  oracleObservations: ["firestore-aggregate-average-empty-and-nonnumeric"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-aggregates.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-aggregates.test.ts"],
});
