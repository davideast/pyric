import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`request.auth == null` when sandbox.currentUser is null (anonymous path)",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"anonymous fallback\"), `oracle:firestore-rules-write-and-cross-doc-verdicts`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-write-and-cross-doc-verdicts"],
  conformanceTests: [
    "packages/pyric/test/firestore/sandbox-live-identity.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
