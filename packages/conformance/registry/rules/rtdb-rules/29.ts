import { row } from './section.ts';

export default row({
  order: 300,
  featureKeys: ["arithmetic"],
  behavior: "Runtime division and modulo by zero (`x / 0`, `x % 0`) match production rather than evaluating `10 / 0` to JavaScript `Infinity` and granting `10 / 0 > 100` (COV-2)",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r38-div-mod-by-zero` (captured 2026-10-15) records 8 production verdicts for runtime division and modulo with a seeded zero divisor: production DENIES `10 / 0 > 100` and ALLOWS the 5 `== 0 || true` / `!(X == 0)` cases and 2 non-zero controls. The simulator evaluates runtime division and modulo by zero to `NaN` without raising an evaluation error, so `10 / 0 > 100` is `false` (DENY) and `== 0 || true` / `!(X == 0)` are `true` (ALLOW), matching all 8 verdicts.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts division and modulo by zero semantics (COV-2)"],
  oracleObservations: ["rules-rtdb-r38-div-mod-by-zero"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/simulator.test.ts"],
  constructs: ["rtdb.operator.div", "rtdb.operator.mod"],
});
