import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["matches"],
  behavior: "`string.matches(regex)` with whole-string anchoring (a partial match denies)",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-10: production capture proves `matches()` is whole-string anchored, matching a RE2 pattern only when it covers the entire string. `oracle:rules-storage-matches-regex` matches production verdict-for-verdict on all 3 cases. RE2-inexpressible patterns are rejected at ruleset compile time by production and are covered by evaluator unit tests instead.",
  oracleObservations: ["rules-storage-matches-regex"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
