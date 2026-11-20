import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "`resource.data.<field>` (existing doc on writes) works under sandbox; undefined-field reads ERROR (RULES-B2)",
  status: "conforms",
  evidence: "`playground:rules-resource-data-field`, `unit:rules/simulator/evaluator.test.ts` (RULES-B2 block), `oracle:firestore-rules-write-and-cross-doc-verdicts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-write-and-cross-doc-verdicts"],
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
