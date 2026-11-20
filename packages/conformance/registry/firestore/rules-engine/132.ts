import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Custom claims in `request.auth.token.<claim>`",
  status: "conforms",
  evidence: "`playground:rules-custom-claims`, `oracle:firestore-rules-write-and-cross-doc-verdicts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-write-and-cross-doc-verdicts"],
  conformanceTests: [
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
