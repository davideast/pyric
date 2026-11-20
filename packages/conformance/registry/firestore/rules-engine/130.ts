import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`request.resource.data.<field>` field validation in rules works under sandbox; an **undefined** field read ERRORS (deny), it does NOT read as null (RULES-B2) -- guard with `'f' in data` / `data.get('f', d)`",
  status: "conforms",
  evidence: "`playground:rules-data-validation`, `unit:rules/simulator/evaluator.test.ts` (RULES-B2 block), `oracle:firestore-rules-write-and-cross-doc-verdicts`",
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
