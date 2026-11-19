import { row } from './section.ts';

export default row({
  order: 160,
  featureKeys: ["query","where","orderBy"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Chained queries re-tag for further constraints (`query(query(coll, where), orderBy)`) without mutating intermediate queries",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-query-chaining-retags-constraints`",
  oracleObservations: ["firestore-query-chaining-retags-constraints"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
