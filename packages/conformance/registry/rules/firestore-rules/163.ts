import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: [],
  behavior: "CEL tri-state error absorption in `||`/`&&` (RULES-B3) — `error || true` → ALLOW, `error && false` → DENY, commutative absorption (not JS left-to-right short-circuit)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-error-absorption-and-or` — production Firestore Rules Test API verdicts for corpus scenario \"error-absorption-and-or\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. The 2026-09-27 recapture adds allow rules after an error (`[1] + [2] == [1, 2]`): a later allow rule for the method, in the same match block or in a second block that matches the path, is still evaluated and grants when true, in either order; an error then a true rule past the 1000-expression limit denies with the earlier error as production's note, where a false rule then the same rule denies with the limit message. `unit:rules/simulator/expression-budget.test.ts` pins the count across the error and the reported error. A second 2026-09-27 recapture adds 19 cases (36 in all) on errors as values: an argument or `let` whose value errors (`1 / request.resource.data.zero`, \"Divide by zero error.\" for `/` and `%`) is bound and the function body runs, so a function that never reads it allows, also through two calls, and one that reads it denies; with two erroring operands production reports the left one of `==` and `+`, the first list element, map value and method argument, the receiver before an argument, and the collection of `in` before its element; and an operand past the 1000-expression limit after an error in the same expression denies with the limit message. The simulator binds the error value and evaluates every operand after one errors; `unit:rules/simulator/error-values.test.ts` pins each verdict and the error production named.",
  oracleObservations: ["rules-firestore-error-absorption-and-or"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/expression-budget.test.ts",
    "packages/rules/test/simulator/error-values.test.ts",
  ],
  constructs: ["firestore.semantic.error-absorption-and","firestore.semantic.error-absorption-or","firestore.operator.and","firestore.operator.or"],
});
