import { row } from './section.ts';

export default row({
  order: 380,
  featureKeys: ["lower", "upper", "trim", "replace", "toUtf8"],
  behavior: "String literal escapes, including `\\x` and octal escapes as code points and `\\u` as one UTF-16 code unit, with `\\/` a parse error; and String `lower()`, `upper()`, `trim()`, `replace(pattern, replacement)`, and `toUtf8()`. `replace` compiles the pattern as a regular expression, replaces every match, expands `$1` group references and reads `\\$` as a dollar sign in the replacement, and is an error on an invalid pattern; `toUtf8()` returns Bytes. An int has no string methods, which is an error",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "CONFORMS, 2026-09-24: `oracle:rules-storage-stdlib-string-bytes-hashing` captures 19 production verdicts for corpus scenario \"stdlib-string-bytes-hashing\"; its case and replace cases pin regular-expression replace-all, Java `Matcher` replacement templates, and `Invalid regular expression pattern` on `(`. A `$&` replacement makes the Rules Test API answer HTTP 500 for the whole request, so production's verdict for an invalid group reference is not captured; the evaluator denies it as an error. `unit:storage/rules-oracle-conformance.test.ts` replays all 19 verdicts and `unit:storage/sandbox/rules-string-methods.test.ts` pins the methods, the replacement templates, and the receiver and argument errors. ROW EXTENDED, 2026-09-27: the same capture adds 18 production verdicts for string literal escapes in Storage rules, 37 in all, the same cases and verdicts as the string escape cases of the Firestore capture rules-firestore-string-literals-and-regex. A backslash escapes a backslash, either quote, `n`, `r`, `t`, `b`, or `f`. `\\x` takes exactly two hexadecimal digits and `\\` takes three octal digits up to 377; each is the code point of that value, not a byte. `\\u` takes exactly four hexadecimal digits and is one UTF-16 code unit, and `size()` counts code units. Production rejects the Storage ruleset for the same malformed escapes as the Firestore one, including `\\/`, `\\a`, `\\v`, `\\0`, `\\x4`, `\\U` escapes, and a raw line break inside the quotes, and the shared grammar rejects them. The grammar previously rejected `\\x`, `\\u`, octal, `\\b`, and `\\f` escapes and accepted `\\/`. `unit:storage/rules-oracle-conformance.test.ts` replays all 37 verdicts and `unit:storage/sandbox/rules-string-escapes.test.ts` pins the string escape cases.",
  risk: ["specific-value", "rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 2 specific value(s)", "asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-stdlib-string-bytes-hashing"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-string-methods.test.ts",
    "packages/rules/test/storage/sandbox/rules-string-escapes.test.ts",
    "packages/rules/test/grammar/string-escape-strict.test.ts",
  ],
  constructs: ["storage.method.string.matches", "storage.method.size"],
});
