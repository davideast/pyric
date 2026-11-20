import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "Type-strict operators: `+` requires supported operand types (`'a' + 1` and `[1] + [2]` error; `list.concat(list)` joins lists); ordered compares (`< > <= >=`) error across types; list membership uses value equality; `is map` excludes MapDiff/Set (RULES-B6 partial / B9 / B12 partial)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B6 / B9 / B12 blocks), `oracle:firestore-rules-cel-expressions-and-set-equality`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-cel-expressions-and-set-equality"],
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
