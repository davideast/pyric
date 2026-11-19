import { row } from './section.ts';

export default row({
  order: 170,
  featureKeys: [],
  behavior: "A `.read`, `.write`, or `.validate` expression that errors at evaluation, such as `.length` or a string method on a number or on null, or a method argument that is not a string (null from a missing value or a signed-out `auth.uid`, or a number), fails as that rule; an argument is never converted to a string: the error fails the whole expression, including on the left of `||` and under `!`. A `.validate` that errors denies the write, and a `.read` or `.write` that errors does not grant, so a descendant rule on the path can still grant",
  evidence: "`oracle:rules-rtdb-r17-validate-runtime-error`: production DENIES a number written under `newData.val().length > 2` and under `newData.val().toUpperCase() == 'OK'`, ALLOWS strings that satisfy them, and DENIES under a type guard that short-circuits first. The simulator matches all 5 cases. `oracle:rules-rtdb-r26-rule-runtime-error` (captured 2026-09-27) extends this to `.read` and `.write`: production DENIES a read and a write whose rule calls `toUpperCase()` on a number, ALLOWS a read and a write under a descendant rule that grants below an ancestor rule that errors, DENIES `newData.val().toUpperCase() == 'OK' || newData.isNumber()` and `!(newData.val().toUpperCase() == 'OK')` for the number 5, and DENIES `toUpperCase()` on a missing child value. `simulate` counts such an error as the rule failing, the verdict the sandbox returns, and matches all 13 cases. `oracle:rules-rtdb-r32-method-argument-types` (captured 2026-10-07) records production DENYING `contains`, `beginsWith` and `hasChild` given a missing value or a number, `child(auth.uid)` for a signed-out read with a `null` key stored, and `replace` given a number replacement, and ALLOWING each with a string argument and `hasChildren([])` on an object and on a leaf. The simulator raises the same error for each, and simulate and the sandbox match all 16 cases (`unit:rules/rtdb/argument-and-operand-sandbox.test.ts`). Extended 2026-10-15 (LNT-1): `oracle:rules-rtdb-r41-error-and-false-short-circuit` records 8 production verdicts for `!(X && false)`, `(X && false) || true`, and `(X && false) ? false : true` in `.read` and `.write` when `X` calls `toUpperCase()` on a number versus a string; production DENIES all 5 erroring cases and ALLOWS all 3 string controls, and the simulator matches all 8.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-rtdb-r17-validate-runtime-error", "rules-rtdb-r26-rule-runtime-error", "rules-rtdb-r32-method-argument-types", "rules-rtdb-r41-error-and-false-short-circuit"],
  conformanceTests: [
    "packages/rules/test/rtdb/rules-conformance.test.ts",
    "packages/pyric/test/rules/rtdb/simulation/handler.test.ts",
    "packages/pyric/test/rules/rtdb/simulate-sandbox-agreement.test.ts",
    "packages/rules/test/rtdb/grammar/method-argument-types.test.ts",
    "packages/pyric/test/rules/rtdb/argument-and-operand-sandbox.test.ts",
  ],
  constructs: ["rtdb.rule-kind.validate"],
});
