import { row } from './section.ts';

export default row({
  order: 320,
  featureKeys: ["auth.token"],
  behavior: "Dynamic indexing on `auth.token[expr]` when `expr` evaluates to `null` (a missing child value) fails the rule as production does rather than coercing `null` to the claim key `\"null\"` via `String(idx)` (FUZ-4)",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r40-auth-token-dynamic-index` (captured 2026-10-15) records 4 production verdicts: production DENIES `auth.token[data.child('k').val()] == true` with claim `\"null\": true` and missing `k`, DENIES `auth.token[data.child('k').val()] == true || true` with missing `k`, ALLOWS numeric `k = 5` with claim `\"5\": true`, and ALLOWS string `k = \"ok\"` with claim `\"ok\": true`. `CallExpr_indexAccess` raises `RtdbRuleRuntimeError` when the index is not a string or number, matching all 4 verdicts.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts dynamic auth.token[null] indexing fails the rule (FUZ-4)"],
  oracleObservations: ["rules-rtdb-r40-auth-token-dynamic-index"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/simulator.test.ts"],
  constructs: ["rtdb.operator.index", "rtdb.binding.auth.token"],
});
