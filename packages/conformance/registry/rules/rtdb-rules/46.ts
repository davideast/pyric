import { row } from './section.ts';

export default row({
  order: 470,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check accepts `\"` and `<` in a regular expression, a `^` inside a character set that is not first, and a `$` alone in a set, as production does",
  evidence: "`oracle:rules-rtdb-r57-deploy-regex-operators` (captured 2026-10-27 on pyric-oracle-rtdb-2, 4 dry-run deploy cases) records production ACCEPTING `/^a\"b$/`, `/^a<b$/`, `/^[a^]$/` and `/^[$]$/`; `rtdbRegexError` accepts all four. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts quote, less-than and in-set anchor characters load as production loads them"],
  oracleObservations: ["rules-rtdb-r57-deploy-regex-operators"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
