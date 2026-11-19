import { row } from './section.ts';

export default row({
  order: 350,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "`matches()` evaluates a regular expression as production does: lookahead `(?=`, negative lookahead `(?!`, a backreference `\\1` and a word boundary `\\b` never match as JavaScript reads them (`\\b` reads as the letter `b` and `\\1` as the digit `1`), so `!matches()` over them grants, and `.` matches `\\n` and `\\r` (SP-2b, SP-8)",
  evidence: "`oracle:rules-rtdb-r47-regex-runtime` (captured 2026-10-26, 16 cases) records production DENYING a lookahead requiring a digit on `ab1`, a negative lookahead refusing `admin` on `guest`, a backreference on `aa` and a word boundary on `a cat sat`, and ALLOWING `/^a.b$/` on `a\\nb`. `oracle:rules-rtdb-r50-regex-unsupported-semantics` (captured 2026-10-26, 12 cases) records production ALLOWING `!matches()` over a negative lookahead on `guest`, a lookahead on `ab1`, a backreference on `aa` and a word boundary on `a cat sat`, ALLOWING `/\\bcat\\b/` on `bcatb` and `/^(a)\\1$/` on `a1`, and ALLOWING `/^a.b$/` on `a\\rb`. The simulator now parses production's dialect (`rules/rtdb/grammar/regex.ts`: a leading `^` and trailing `$` stripped, `.*` for a missing one, a backslash making the next character literal except `\\d \\w \\s` and their capitals, `.` matching every character) and matches it with the shared linear-time NFA (`rules/simulator/regex-nfa.ts`), so it agrees with all 28 r47 and r50 cases, including `$` not matching before a trailing newline (SP-7 refuted), the `i` flag, an unanchored pattern and a lazy quantifier; `unit:rules/rtdb/rules-conformance.test.ts` replays them with no pin. `unit:rules/rtdb/grammar/regex-dialect.test.ts` covers the dialect and `^(a+)+$` in linear time (LD-6), and `unit:database/sandbox/rules-regex-dialect.test.ts` covers the in-page sandbox. Fixed in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts matches() grants and denies as production does under lookahead, backreference, \\b and . against line terminators"],
  oracleObservations: ["rules-rtdb-r47-regex-runtime", "rules-rtdb-r50-regex-unsupported-semantics"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/rules/test/rtdb/grammar/regex-dialect.test.ts", "packages/pyric/test/database/sandbox/rules-regex-dialect.test.ts"],
  constructs: ["rtdb.method.string.matches", "rtdb.semantic.regex-literal"],
});
