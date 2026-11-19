import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["query","where","orderBy","limit"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`query(coll, where(...), orderBy(...), limit(...))` composes constraints in order",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-query`, `oracle:firestore-query-compose-where-orderby-limit`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["firestore-query-compose-where-orderby-limit"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
