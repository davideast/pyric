import { row } from './section.ts';

export default row({
  order: 460,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "`matches()` reads `\\s`, `\\w` and `\\d` as ASCII classes, folds case under `i` by adding each pattern character's own upper and lower case, and reads `& ~ # @ >`, an escaped `n` and the `|` of an empty alternative as plain characters",
  evidence: "`oracle:rules-rtdb-r56-regex-classes-runtime` (captured 2026-10-27, 40 cases) records production ALLOWING `/^\\s$/` only on space, tab, line feed, vertical tab, form feed and carriage return and DENYING it on U+00A0, U+2003, U+3000, U+FEFF, U+2028, U+0085 and U+001C (and ALLOWING `/^\\S$/` on U+00A0); DENYING `\\w` on `é` and `\\d` on U+0663; under `i`, ALLOWING k/K, é/É, `[a-z]`/Q and dotless ı/I and DENYING k against the Kelvin sign and `[^a]`/A; ALLOWING `a&b`, `a~b`, `a#b`, `a@b` and `a>b` as literals and DENYING every near miss; matching the Zod email pattern on `a@b.co` only; reading `\\n` as the letter n; and matching `/^(|a)$/` only on `|a`. The simulator (`rules/rtdb/grammar/regex-parser.ts`) matches all 40; `unit:rules/rtdb/rules-conformance.test.ts` replays them. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts matches() over whitespace and word classes, case folding and dk.brics operator characters allows and denies as production does"],
  oracleObservations: ["rules-rtdb-r56-regex-classes-runtime"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/regex-dialect.test.ts"],
  constructs: ["rtdb.method.string.matches", "rtdb.semantic.regex-literal"],
});
