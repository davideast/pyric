import { row } from './section.ts';

export default row({
  order: 230,
  featureKeys: ["arithmetic","comparison"],
  behavior: "An arithmetic or ordering operator with a null operand fails the rule: `+` with a number or a string on either side, `-`, `*`, `/`, `%`, unary `-`, `<`, `<=`, `>` and `>=` applied to `data.val()` where nothing is stored are evaluation errors, so `newData.val() == data.val() + 1` denies a create and `data.val() + 1 == 1 || true` denies. `==` and `!=` compare null without an error",
  evidence: "`oracle:rules-rtdb-r27-stdlib-core-patterns` (captured 2026-10-07) records production DENYING a write of 1 under `newData.val() == data.val() + 1` where nothing is stored, and under each of `data.val() + 1 == 1 || true`, `1 + data.val() == 1 || true`, `data.val() - 1 == -1 || true`, `data.val() * 2 == 0 || true`, `data.val() + 'a' == 'nulla' || true`, `-data.val() == 0 || true` and `data.val() < 1 || true`, and denying `data.val() + 1 != 1`. The `|| true` cases deny only if the left side is an error, so each operator with a null operand fails the whole rule. `oracle:rules-rtdb-r33-null-operands` (captured 2026-10-07) records production DENYING `/`, `%`, `<=`, `>` and `>=` with a null operand under `|| true`, on either side, and ALLOWING each with a stored number. The simulator and the sandbox raise a rule runtime error for a null operand of each of these operators and match every case in both captures: `unit:rules/rtdb/stdlib/corpus-lock.test.ts` replays r27-stdlib-core-patterns and `unit:rules/rtdb/argument-and-operand-sandbox.test.ts` replays r33-null-operands through simulate and the sandbox, and `unit:rules/rtdb/grammar/method-argument-types.test.ts` pins `==`, `!=`, `===` and `!==` comparing null on either side without an error. Every RTDB rules standard library builder that computes with a stored value checks first that it exists or is a number, and the library's 49 cases in the same capture agree with production.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-rtdb-r27-stdlib-core-patterns", "rules-rtdb-r33-null-operands"],
  conformanceTests: [
    "packages/rules/test/rtdb/rules-conformance.test.ts",
    "packages/pyric/test/rules/rtdb/stdlib/corpus-lock.test.ts",
    "packages/pyric/test/rules/rtdb/argument-and-operand-sandbox.test.ts",
    "packages/rules/test/rtdb/grammar/method-argument-types.test.ts",
  ],
  constructs: ["rtdb.operator.add", "rtdb.operator.sub", "rtdb.operator.mul", "rtdb.operator.div", "rtdb.operator.mod", "rtdb.operator.neg", "rtdb.operator.lt", "rtdb.operator.lte", "rtdb.operator.gt", "rtdb.operator.gte"],
});
