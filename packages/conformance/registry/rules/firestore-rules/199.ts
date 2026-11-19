import { row } from './section.ts';

export default row({
  order: 370,
  featureKeys: ["matches", "split", "replace"],
  behavior: "`matches()`, `split()` and `replace()` use RE2: `\\s` is `[\\t\\n\\f\\r ]`, `.` matches `\\r`, `\\pL`, `[[:alpha:]]` and `\\Q..\\E` are a class, a POSIX class and literal quoting, `split()` does not return capture-group text, and `(?i)` applies in `split()` and `replace()` (FS2-SIM-4, FS2-SIM-5a, FS2-SIM-5a2, FS2-SIM-5b, FS2-SIM-5c, FS2-SIM-5d, FS2-SIM-6)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-re2-pattern-semantics` (captured 2026-10-27, recaptured 2026-10-28 with 6 more cases, 34 in all, every earlier verdict unchanged) records production ALLOWING `NBSP is not \\s`, `em space is not \\s`, `vertical tab is not \\s`, `real nbsp from data is not \\s`, `dot matches carriage return`, `a is \\pL`, `a is [[:alpha:]]`, `quoted a.b matches a.b`, `split on a capturing group returns two pieces`, `split with (?i) splits both cases`, `replace \\s leaves NBSP`, `split dot matches carriage return`, `replace dot matches carriage return`, `replace (?s) dot matches newline`, `split (?i)k splits on the Kelvin sign` and `replace (?i)k replaces the Kelvin sign`. The simulator agrees on all 34 cases.",
  risk: ["rules-denial"],
  riskScore: 4,
  riskReasons: ["a whitespace or class guard built on matches() allows or denies differently from production"],
  oracleObservations: ["rules-firestore-re2-pattern-semantics"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/re2-space-and-trim.test.ts",
    "packages/rules/test/simulator/re2-dot-property-and-flags.test.ts",
    "packages/rules/test/simulator/split-and-replace.test.ts",
  ],
  constructs: [
    "firestore.method.string.matches",
    "firestore.method.string.split",
  ],
});
