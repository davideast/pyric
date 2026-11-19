import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["compose"],
  behavior: "`compose` exports the boolean combinators `all`, `any`, `not`, `deny`, `always`, the raw `expr` constructor, and `lit`, the single-quoted rule literal every builder writes; `all` and `any` add only the parentheses an operand needs (an `||` or ternary under `&&`, an `&&` or ternary under `||`), and the RTDB standard library composes its builders from these. `all` or `any` with no non-empty operand throws, and `lit` throws on a string with a newline or another control character; its quote and backslash escapes match the Pyric simulator",
  evidence: "`unit:constraints/compose.test.ts` pins the grouping, including an `||` inside parentheses, quotes or a regex literal left ungrouped, that a composition still parses, the empty `all`/`any` errors, the `lit` control-character refusal, and that each escaped literal reads back as its value in the simulator. These errors are Pyric authoring checks with no production counterpart. The RTDB standard library captures `rules-rtdb-r27-stdlib-core-patterns`, `rules-rtdb-r28-stdlib-presence-timing` and `rules-rtdb-r34-stdlib-auth-membership-quota` were recaptured after the standard library moved onto these combinators, with every verdict unchanged, and replayed across simulator, sandbox, SharedWorker, and Node host.",
  oracleObservations: ["rules-rtdb-r27-stdlib-core-patterns", "rules-rtdb-r28-stdlib-presence-timing", "rules-rtdb-r34-stdlib-auth-membership-quota"],
  conformanceTests: ["packages/rules/test/rtdb/constraints/compose.test.ts", "packages/conformance/test/rtdb-rules/capture-stdlib-and-deploy-refusals.test.ts", "packages/conformance/test/rtdb-rules/served-stdlib-and-deploy-refusals.test.ts"],
});
