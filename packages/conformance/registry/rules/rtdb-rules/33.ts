import { row } from './section.ts';

export default row({
  order: 340,
  featureKeys: [],
  behavior: "Pyric's load-time check (`rtdbRulesSourceRejection`) and `checkRtdbRules` (`localDeployVerdict`) match production dry-run deploy validation for structural non-object children and unknown dotted keys (`CON-6`), `auth[...]` indexing (`FUZ-4`), double-quoted and single-quoted string escape sequences and raw newlines (`FUZ-1`), and regular expression literals in `matches()` (`FUZ-2`, `FUZ-8`), alongside `1e309` (`COV-2`) and `root.parent()` (`COV-1`)",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r43-deploy-expression-and-structure-probes` (captured 2026-10-15, 14 dry-run deploy cases) records production ACCEPTING `1e309 > 100` (COV-2), `(true ? root.parent() : null) == null` and `((true ? root.parent() : 1) == 1) || true` (COV-1), and `auth.token[data.child('k').val()] == true` (FUZ-4), and REJECTING `root.parent() != null || true` (COV-1), `auth[data]`, `auth[true]`, `auth[null]` (FUZ-4, \"Invalid property access on 'auth' object.\"), `\".valdiate\": false`, child values `true`, `null`, `42`, `[{\".read\": true}]` (CON-6, \"Expected '{'.\"), and `\".read\": [true]` (CON-6, \"Invalid rule expression.\"). `oracle:rules-rtdb-r44-deploy-string-and-regex-probes` (captured 2026-10-15, 9 dry-run deploy cases) records production ACCEPTING `\"\\'\"`, `\"\\x41\"`, and raw tab in double-quoted rule strings (FUZ-1), `/+/`, `/[z-a]/`, `/a{2,1}/` (FUZ-2), and `/^[^/]+$/` (FUZ-8), and REJECTING a raw newline in a double-quoted rule string (FUZ-1, \"unterminated string literal\") and `matches(/(/)` (FUZ-2, \"Illegal regular expression, expected ')' at position 5\"). Both `rtdbRulesSourceRejection` and `localDeployVerdict` (`checkRtdbRules(() => compileRtdbRules(...))`) agree with production on 14/14 in `r43` and 9/9 in `r44`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts deploy-time expression, structure, string-escape, and regex validation matches production across r43 and r44"],
  oracleObservations: ["rules-rtdb-r43-deploy-expression-and-structure-probes", "rules-rtdb-r44-deploy-string-and-regex-probes"],
  conformanceTests: ["packages/rules/test/rtdb/source-rejection.test.ts", "packages/rules/test/rtdb/grammar/regex-literals-and-constant-comparisons.test.ts", "packages/rules/test/rtdb/grammar/validator-types.test.ts", "packages/rules/test/rtdb/grammar/simulator.test.ts", "packages/conformance/src/rules-rtdb-replay.test.ts"],
  constructs: [
    "rtdb.rule-kind.unknown-key", "rtdb.rule-kind.non-object-child", "rtdb.rule-kind.non-expression-value",
    "rtdb.operator.index", "rtdb.operator.looseEq", "rtdb.semantic.regex-literal",
  ],
});
