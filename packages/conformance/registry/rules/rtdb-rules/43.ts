import { row } from './section.ts';

export default row({
  order: 440,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "`matches()` applies production's anchor rewrite to a top-level alternation: with no group around the pattern, `/cat|dog/` reads as `.*cat|dog.*` (a string ending in cat or starting with dog) and `/^a|b$/` as exactly `a` or `b`, where JavaScript reads both as \"contains either side\"",
  evidence: "`oracle:rules-rtdb-r54-regex-alternation-runtime` (captured 2026-10-27, 10 cases) records production DENYING `/cat|dog/` on `a cat here` and `hotdog` and ALLOWING it on `bobcat`, `dogs` and `cat`, DENYING `/^a|b$/` on `ax` and `xb` and ALLOWING it on `a`, and, for the control `/(cat|dog)/`, ALLOWING `a cat here` and DENYING `a cow here`. The simulator (`rules/rtdb/grammar/regex.ts`) matches all 10; `unit:rules/rtdb/rules-conformance.test.ts` replays them. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts matches() over a top-level alternation allows and denies as production does, not as JavaScript does"],
  oracleObservations: ["rules-rtdb-r54-regex-alternation-runtime"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/regex-dialect.test.ts"],
  constructs: ["rtdb.method.string.matches", "rtdb.semantic.regex-literal"],
});
