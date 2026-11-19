import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "**Query reads enforce security rules (FS-B1)** — a deny-all / auth-gated rule set throws `permission-denied`. Pre-FS-B1 query reads went through the rules-bypassing `listDocuments` and returned the whole collection.",
  status: "conforms",
  evidence: "`unit:admin-compat/query-rules-enforcement.test.ts` (deny-all + auth-gated `getDocs`/aggregate), `unit:admin-compat/per-op-auth.test.ts` (\"Query.get enforces rules\")",
  risk: ["specific-value","error-code","rules-denial"],
  riskScore: 7,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `permission-denied`","asserts rules-denial behavior"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/admin-compat/per-op-auth.test.ts","packages/pyric/test/sandbox/firestore/admin-compat/query-rules-enforcement.test.ts"],
  rowNumber: 24,
});
