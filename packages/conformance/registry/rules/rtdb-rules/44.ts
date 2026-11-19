import { row } from './section.ts';

export default row({
  order: 450,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check accepts a regular expression the anchor rewrite leaves empty or nearly empty: `/^$/` (the empty string), `/^/`, `/$/` and `/^()$/`",
  evidence: "`oracle:rules-rtdb-r55-deploy-regex-empty` (captured 2026-10-27, 4 dry-run deploy cases) records production ACCEPTING `/^$/`, `/^/`, `/$/` and `/^()$/`. `rtdbRegexError` (`rules/rtdb/grammar/regex.ts`) accepts all four; `unit:conformance/rules-rtdb-replay.test.ts` replays them and `unit:rules/rtdb/grammar/regex-dialect.test.ts` checks that `/^$/` matches only the empty string. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts empty regular expressions load as production loads them"],
  oracleObservations: ["rules-rtdb-r55-deploy-regex-empty"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts", "packages/rules/test/rtdb/grammar/regex-dialect.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
