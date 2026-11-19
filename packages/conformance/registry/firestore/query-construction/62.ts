import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["query","or","orderBy","limit"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Composite filters compose with `orderBy`/`limit`, nested `and(where(...), or(...))`, and chained `query(query(coll, where(...)), or(...))`; mixing a composite filter with another filter at the top level of one `query()` call throws `FirebaseError` (`invalid-argument`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-composite-or-with-orderby-and-limit`",
  oracleObservations: ["firestore-composite-or-with-orderby-and-limit"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
