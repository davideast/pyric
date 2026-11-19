import { row } from './section.ts';

export default row({
  order: 80,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Empty result for a collection with no docs (`size === 0`, `empty === true`)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-getdocs-snapshot-empty-and-doc-refs`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["firestore-getdocs-snapshot-empty-and-doc-refs"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts"],
});
