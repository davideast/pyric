import { row } from './section.ts';

export default row({
  order: 10,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Returns `QuerySnapshot` with `size`, `empty`, `docs` (`QueryDocumentSnapshot[]`)",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-query`, `oracle:firestore-getdocs-snapshot-empty-and-doc-refs`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["firestore-getdocs-snapshot-empty-and-doc-refs"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts"],
});
