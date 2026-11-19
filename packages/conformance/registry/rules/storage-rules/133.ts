import { row } from './section.ts';

export default row({
  order: 330,
  featureKeys: [],
  behavior: "CEL commutative error absorption in && and ||: a determining operand (false for &&, true for ||) absorbs the other operand's error; error && true and true && error both propagate to deny",
  status: "conforms",
  evidence: "NEW ROW, 2026-09-01: `oracle:rules-storage-error-absorption-and-direction` captures the previously unpinned && direction of corpus scenario \"error-absorption-and-direction\" via consumed discriminators (!(error && false) and (error && false) == false both ALLOW; both propagation orders DENY; the || direction is consumed as a control). The local evaluator replays all six verdicts with no divergence pin after the tri-state operand change in storage/sandbox/rules-evaluator.ts, which mirrors the captured Firestore semantics (RULES-B3). The 2026-09-27 recapture adds allow rules after an error (`1 / 0 == 0`): a later true rule in the same block or a second matching block allows, a later false rule denies, and an error then a true rule past the 1000-expression limit denies with the earlier error as production's note; `unit:storage/sandbox/rules-expression-budget.test.ts` pins the count and the reported error. A second 2026-09-27 recapture adds 8 cases (18 in all): an int division or modulo by `request.resource.size` of 0 is \"Divide by zero error.\"; with two erroring operands production reports the left one of `==`, the first list element and method argument, the receiver before an argument, and the collection of `in` before its element; and an operand past the limit after an error in the same expression denies with the limit message. `unit:storage/sandbox/rules-error-values.test.ts` pins the errors production named.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-error-absorption-and-direction"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-expression-budget.test.ts",
    "packages/rules/test/storage/sandbox/rules-error-values.test.ts",
  ],
  constructs: ["storage.operator.and", "storage.operator.or"],
});
