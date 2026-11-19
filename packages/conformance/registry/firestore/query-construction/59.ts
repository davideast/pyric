import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["orderBy"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`orderBy(field, 'asc'|'desc')` -- direction parameter (defaults to `'asc'`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-orderby-direction-asc-desc`",
  oracleObservations: ["firestore-orderby-direction-asc-desc"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
