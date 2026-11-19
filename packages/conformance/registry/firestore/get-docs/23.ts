import { row } from './section.ts';

export default row({
  order: 30,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Each `snap.docs[i].ref` is tagged for follow-up ops",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-getdocs-snapshot-empty-and-doc-refs`",
  oracleObservations: ["firestore-getdocs-snapshot-empty-and-doc-refs"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts"],
});
