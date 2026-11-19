import { row } from './section.ts';

export default row({
  order: 40,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`snap.ref` is tagged so it routes through `targetOf` in follow-up ops",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-getdoc-snapshot-shape-missing-and-ref`",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  oracleObservations: ["firestore-getdoc-snapshot-shape-missing-and-ref"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts"],
});
