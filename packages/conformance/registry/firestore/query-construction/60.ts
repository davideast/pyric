import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["limit"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`limit(n)` -- caps result count and throws `FirebaseError` (`invalid-argument`) synchronously when `n <= 0`",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-limit-caps-result-count`",
  oracleObservations: ["firestore-limit-caps-result-count"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
