import { row } from './section.ts';

export default row({
  order: 170,
  behavior: "Query-proof ENFORCEMENT wiring -- `RulesReadEngine` routes one-shot and listener lists through `RulesListAuthorizer` and `proveListQuery`. Residual evaluation uses only the projected provable rules and query-pinned resource fields. Rejected-rule evidence remains available for denial diagnostics even when a provable fallback evaluates false. Full filter identity is diagnostic metadata; only supported constraints participate in proof. `request.query.{limit,offset,orderBy}` is populated on list test cases (RULES-B11; scope caveat: row 24c).",
  status: "conforms",
  evidence: "Local query support: `unit:firestore/query-proof-application.test.ts` covers finite membership, guardian array membership, pinned lookup paths, auth and limit controls, and adversarial array/lookup cases. Upstream semantics: firebase.google.com/docs/firestore/security/rules-query and firebase.google.com/docs/firestore/query-data/queries. Local diagnostic contract (#583): `unit:firestore/query-proof-diagnostics.test.ts` pins dynamic membership rejection, fallback attribution, constraint/residual distinctions, modular listener context, captured lifecycle errors, and immutable operation-summary proof metadata. `unit:firestore/query-proof-enforcement.test.ts` (both paths; prover scope caveat: row 24c), `oracle:firestore-query-proof-and-read-rules`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-query-proof-and-read-rules"],
  conformanceTests: [
    "packages/pyric/test/firestore/query-proof-application.test.ts",
    "packages/pyric/test/firestore/query-proof-diagnostics.test.ts",
    "packages/pyric/test/firestore/query-proof-enforcement.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
  rowNumber: 139,
});
