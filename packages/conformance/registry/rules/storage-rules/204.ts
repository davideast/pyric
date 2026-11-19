import { row } from './section.ts';

export default row({
  order: 420,
  featureKeys: ["matches"],
  behavior: "`matches()` uses RE2: `\\s` is `[\\t\\n\\f\\r ]`, `.` matches `\\r`, `\\pL`, `[[:alpha:]]` and `\\Q..\\E` are a class, a POSIX class and literal quoting, and `(?i)k` matches the Kelvin sign U+212A (ST-H1-3, sharing FS2-SIM-5a, FS2-SIM-5a2, FS2-SIM-5b, FS2-SIM-5c and FS2-SIM-5d)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-regex-re2-classes` (captured 2026-10-27, 16 cases) records production verdicts for POSIX classes, `\\pL`, `\\s` and `\\S` over NBSP, U+2003 and vertical tab, `.` against `\\r`, `\\Q..\\E` and `(?i)` over the Kelvin sign. The Storage evaluator agrees on all 16 cases.",
  risk: ["rules-denial"],
  riskScore: 4,
  riskReasons: ["a whitespace or class guard built on matches() allows or denies differently from production"],
  oracleObservations: ["rules-storage-h1-regex-re2-classes"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-string-methods.test.ts",
  ],
  constructs: ["storage.method.string.matches"],
});
