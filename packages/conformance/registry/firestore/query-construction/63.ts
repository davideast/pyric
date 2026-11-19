import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["or","and","orderBy","limit"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Passing non-filter constraints (`orderBy`, `limit`, `limitToLast`, cursors) into `or()` / `and()` -> `FirebaseError` (`invalid-argument`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-composite-rejects-nonfilter-constraints`",
  oracleObservations: ["firestore-composite-rejects-nonfilter-constraints"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
