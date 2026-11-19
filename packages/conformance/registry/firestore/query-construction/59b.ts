import { row } from './section.ts';

export default row({
  order: 90,
  rowNumber: 59,
  featureKeys: ["orderBy"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "**orderBy excludes missing-field docs (FS-B3)** -- a doc lacking an orderBy field is omitted from the result while explicit `null` is retained.",
  evidence: "`unit:firestore/sandbox/query-value-order.test.ts`, `oracle:firestore-orderby-excludes-missing-field`",
  oracleObservations: ["firestore-orderby-excludes-missing-field"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox/query-value-order.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
