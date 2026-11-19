import { row } from './section.ts';

export default row({
  order: 430,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check refuses a malformed regular expression with production's deploy error text: an unmatched `)` (\"end-of-string expected\"), an unclosed `(`, repeat count or character set at production's position, and an empty alternative left by the anchor strip, and it deploys a `)` after a leading `^` as a literal",
  evidence: "`oracle:rules-rtdb-r53-deploy-regex-paren` (captured 2026-10-27, 10 dry-run deploy cases) records production REJECTING `/)/` and `/a)b/` (\"Illegal regular expression, end-of-string expected\"), `/^(/` (\"expected ')' at position 3\"), `/^(a$/` (position 2), `/a(b/` (position 7), `/a{2/` (\"expected '}' at position 5\"), `/^a|$/` (\"unexpected end-of-string\") and `/^[]$/` (\"expected ']' at position 2\"), and ACCEPTING `/^)/` and `/^(a)$/`. The positions count from the pattern production parses: the leading `^` and trailing `$` stripped, `.*` for a missing one. `rtdbRegexError` (`rules/rtdb/grammar/regex.ts`) agrees on all 10 with the exact texts; `unit:conformance/rules-rtdb-replay.test.ts` replays the verdicts and `unit:rules/rtdb/grammar/regex-dialect.test.ts` the texts. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts malformed regular expressions fail at load with production's deploy text and position"],
  oracleObservations: ["rules-rtdb-r53-deploy-regex-paren"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts", "packages/rules/test/rtdb/grammar/regex-dialect.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
