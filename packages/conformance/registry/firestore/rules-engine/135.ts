import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "No JS prototype-chain leakage: `'toString' in data` -> false, `data.constructor` errors; `in`/`hasAll`/`get` use own keys only (RULES-B7)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B7 block), `oracle:firestore-rules-cel-expressions-and-set-equality`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-cel-expressions-and-set-equality"],
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
