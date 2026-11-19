import { row } from './section.ts';

export default row({
  order: 400,
  featureKeys: [],
  behavior: "Under Node, `lint()` and `simulate()` read a `||` chain of 500, 501 and 2,000 terms, as production deploys each (LD-7)",
  evidence: "`oracle:rules-rtdb-r51-deploy-anchor-index-and-length-probes` (captured 2026-10-26) records production ACCEPTING `.read` rules that chain 500, 501 and 2,000 `auth.uid == 'u<n>'` terms with `||`. Before the fix, every semantics pass over the left-recursive grammar descended once per term, and a fresh Node process (22.15 and 24.16 alike) exhausted its default stack at 499 terms; whether 500 or 501 terms overflowed in a process that had already run other cases depended on JIT warm-up and case order, not the Node version. `lint()` then reported PARSE_ERROR and `simulate()` returned UNSUPPORTED. `||` and `&&` now match as flat chains folded in a loop, and `unit:rules/rtdb/node-stack.test.ts` runs each ruleset in its own fresh Node child against `dist` and asserts agreement with production for all three. The row scopes `rtdb.operator.or` because the r51 cases attribute themselves to it; the defect was the parser's recursion depth over a chain, not how `||` evaluates. Fixed in #1247 stream S5 (LD-7).",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["rules production deploys report a lint error and an UNSUPPORTED verdict locally"],
  oracleObservations: ["rules-rtdb-r51-deploy-anchor-index-and-length-probes"],
  conformanceTests: ["packages/rules/test/rtdb/node-stack.test.ts"],
  constructs: ["rtdb.operator.or"],
});
