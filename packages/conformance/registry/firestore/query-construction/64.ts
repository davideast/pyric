import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["or","and"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Zero-arg `or()` / `and()` construct cleanly and act as identity filters matching all documents",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-composite-zero-arg-or-and`",
  oracleObservations: ["firestore-composite-zero-arg-or-and"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
