import { row } from './section.ts';

export default row({
  order: 360,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check refuses a regular expression production refuses to deploy: a `^` that is not the first character or a `$` that is not the last, and a Unicode property class `\\p{..}` (SP-1, SP-2a)",
  evidence: "`oracle:rules-rtdb-r46-deploy-regex-constructs` (captured 2026-10-26, 9 dry-run deploy cases) records production REJECTING `/^red$|^blue$/` and `/(^a)/` (\"Illegal regular expression, unescaped ^, ^ can only appear at the end of regular expressions\") and `/^\\p{L}+$/` (\"Illegal regular expression, integer expected at position 3\"), and ACCEPTING lookahead, negative lookahead, a backreference, `\\b`, a lazy quantifier and `/^[a-z0-9-]+$/` (SP-2c refuted). `oracle:rules-rtdb-r51-deploy-anchor-index-and-length-probes` (captured 2026-10-26) records production REJECTING `/a$|b/` and `/(a$)/` with the same text and ACCEPTING `/a\\$b/`. Pyric's load-time check (`rtdbRegexError` in `rules/rtdb/grammar/regex.ts`) refuses all five with production's exact text and accepts the rest; `unit:conformance/rules-rtdb-replay.test.ts` replays them with no pin, and `unit:rules/rtdb/grammar/regex-dialect.test.ts` asserts the texts. Fixed in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts the load-time check refuses the regular expressions production refuses at deploy, with production's error text"],
  oracleObservations: ["rules-rtdb-r46-deploy-regex-constructs", "rules-rtdb-r51-deploy-anchor-index-and-length-probes"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts", "packages/rules/test/rtdb/grammar/regex-dialect.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
