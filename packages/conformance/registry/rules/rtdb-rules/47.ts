import { row } from './section.ts';

export default row({
  order: 480,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check refuses a repeat count past 2^31 - 1 with production's text, Java's `For input string: \"2147483648\"`",
  evidence: "`oracle:rules-rtdb-r58-deploy-regex-count-past-int` (captured 2026-10-27 on pyric-oracle-rtdb-2, 1 dry-run deploy case) records production REJECTING `/^a{2147483648}$/` with `For input string: \"2147483648\"`, the text of Java's NumberFormatException, without the \"Illegal regular expression\" prefix. `rules/rtdb/grammar/regex-limits.ts` reports the same text. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts an oversized repeat count fails at load with production's text"],
  oracleObservations: ["rules-rtdb-r58-deploy-regex-count-past-int"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts", "packages/rules/test/rtdb/grammar/regex-limits.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
