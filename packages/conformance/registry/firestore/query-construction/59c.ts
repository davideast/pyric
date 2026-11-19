import { row } from './section.ts';

export default row({
  order: 100,
  rowNumber: 59,
  featureKeys: ["query","where","and","orderBy"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "**Implicit orderBy + `__name__` tiebreak (FS-B8)** -- the query's sort is normalized to: explicit orderBy clauses, then an implicit order on each inequality-filtered field, then a final document-key (`__name__`) clause matching the last explicit direction (or `'asc'`).",
  evidence: "`unit:admin-compat/implicit-order-name.test.ts`, `oracle:firestore-orderby-implicit-inequality-and-name-tiebreak`",
  oracleObservations: ["firestore-orderby-implicit-inequality-and-name-tiebreak"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/admin-compat/implicit-order-name.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
