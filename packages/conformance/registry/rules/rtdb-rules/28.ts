import { row } from './section.ts';

export default row({
  order: 290,
  featureKeys: ["arithmetic", "comparison", "String"],
  behavior: "Runtime non-number / non-string operands of `-`, `*`, `/`, `%`, unary `-`, `+`, `<`, `>`, `>=`, and `.length` on non-strings fail the rule as production does, rather than coercing booleans, numeric strings, or objects through JavaScript operators or reading a child key named `length` (FUZ-3, MET-2)",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r36-runtime-arithmetic-types` (captured 2026-10-15) records 20 production verdicts for `-`, `*`, `/`, `%`, and unary `-` on runtime booleans, numeric strings, non-numeric strings, and objects (including under `|| true` and `!(X == 0)`): production DENIES all 19 non-number cases and ALLOWS the numeric control `5 - 1 == 4`. `oracle:rules-rtdb-r37-runtime-comparison-and-length-types` (captured 2026-10-15) records 20 production verdicts for `+`, `<`, `>`, `>=`, and `.length`: production ALLOWS string-plus-number concatenation (`\"5\" + 1 == \"51\"` and under `|| true`) and DENIES all 18 boolean/object `+`, mixed-type `<`/`>`/`>=`, and non-string `.length` cases (including `{length: 10}.length > 2`). The simulator raises `RtdbRuleRuntimeError` on non-number arithmetic, boolean/object `+`, mixed-type relational comparisons, and non-string `.length`, matching all 40 verdicts across both captures.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts runtime type-mismatch expressions fail the rule even under || true and ! (FUZ-3, MET-2)"],
  oracleObservations: ["rules-rtdb-r36-runtime-arithmetic-types", "rules-rtdb-r37-runtime-comparison-and-length-types"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/simulator.test.ts"],
  constructs: [
    "rtdb.operator.sub", "rtdb.operator.mul", "rtdb.operator.div", "rtdb.operator.mod", "rtdb.operator.neg",
    "rtdb.operator.add", "rtdb.operator.lt", "rtdb.operator.gt", "rtdb.operator.gte", "rtdb.method.string.length",
  ],
});
