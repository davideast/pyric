import { row } from './section.ts';

export default row({
  order: 50,
  automation: "oracle-backed",
  behavior: "**Query reads enforce security rules (FS-B1)** -- a deny-all / auth-gated rule set throws `permission-denied`. Pre-FS-B1 query reads went through the rules-bypassing `listDocuments` and returned the whole collection.",
  status: "conforms",
  evidence: "`unit:admin-compat/query-rules-enforcement.test.ts` (deny-all + auth-gated `getDocs`/aggregate), `unit:admin-compat/per-op-auth.test.ts` (\"Query.get enforces rules\"), `oracle:firestore-query-proof-and-read-rules`",
  oracleObservations: ["firestore-query-proof-and-read-rules"],
  risk: ["specific-value", "error-code", "rules-denial"],
  riskScore: 7,
  riskReasons: ["asserts 1 specific value(s)", "asserts Firebase error code(s): `permission-denied`", "asserts rules-denial behavior"],
  conformanceTests: [
    "packages/pyric/test/sandbox/firestore/admin-compat/per-op-auth.test.ts",
    "packages/pyric/test/sandbox/firestore/admin-compat/query-rules-enforcement.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
  rowNumber: 24,
});
