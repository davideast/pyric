import { row } from './section.ts';

export default row({
  order: 310,
  featureKeys: ["root"],
  behavior: "Evaluating `root.parent()` at runtime fails the rule expression as production does, so neither `== null` nor `|| true` can evaluate to ALLOW (COV-1). The deploy verdict of `(true ? data.parent() : null).exists()` is row 196",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r39-root-parent-runtime` (re-captured on firebase 12.19.0 for #1676) records 7 production verdicts: production DENIES all 6 `root.parent()` cases (`(true ? root.parent() : null) == null`, `(true ? root.parent() : null) != null || true`, `((true ? root.parent() : 1) == 1) || true`, `(true ? root.parent() : 1) != 1`, `(true ? root.parent() : '').length == null || true`, and `root.parent().exists() || true`) and ALLOWS the non-root `data.parent().exists()` control at `/nested/child`. `DataSnapshot.prototype.parent()` raises `RtdbRuleRuntimeError('Cannot call parent() on root.')` on the root snapshot (`COV-1`), matching all 7 verdicts.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts root.parent() fails the rule at runtime (COV-1)"],
  oracleObservations: ["rules-rtdb-r39-root-parent-runtime"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/simulator.test.ts", "packages/rules/test/rtdb/grammar/validator-types.test.ts"],
  constructs: ["rtdb.binding.root", "rtdb.method.snapshot.parent"],
});
