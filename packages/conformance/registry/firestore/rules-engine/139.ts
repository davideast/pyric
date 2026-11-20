import { row } from './section.ts';

export default row({
  order: 160,
  behavior: "Query-proof EVALUATION -- the rules-side decision (\"rules are not filters\"): given a `list` rule + query constraints, decide provable-or-reject (a doc-dependent rule like `resource.data.visibility == 'public'` is provable ONLY with a matching `where('visibility','==','public')`; otherwise the whole query is rejected) (RULES-B11 rules-side)",
  status: "conforms",
  evidence: "`unit:rules/simulator/query-proof.test.ts`, `oracle:firestore-query-proof-and-read-rules`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-query-proof-and-read-rules"],
  conformanceTests: [
    "packages/rules/test/simulator/query-proof.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
