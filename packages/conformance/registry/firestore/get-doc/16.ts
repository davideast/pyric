import { row } from './section.ts';

export default row({
  order: 10,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Returns `DocumentSnapshot` with `id`, `exists` (method form), `data()`",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-getdoc-snapshot-shape-missing-and-ref`",
  oracleObservations: ["firestore-getdoc-snapshot-shape-missing-and-ref"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts"],
});
