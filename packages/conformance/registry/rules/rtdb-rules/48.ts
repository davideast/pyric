import { row } from './section.ts';

export default row({
  order: 490,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check refuses `a{100000}` with production's \"could not determinize efficiently\" text",
  evidence: "`oracle:rules-rtdb-r59-deploy-regex-count-100000` (captured 2026-10-27 on pyric-oracle-rtdb-2, 1 dry-run deploy case) records production REJECTING `/^a{100000}$/` with \"Illegal regular expression, could not determinize efficiently\". Production's exact threshold is unobserved: pyric refuses a pattern with more than 10,000 character positions once its repeats are expanded, and every accepted corpus pattern has at most 12. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts a pattern too large to determinize fails at load with production's text"],
  oracleObservations: ["rules-rtdb-r59-deploy-regex-count-100000"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts", "packages/rules/test/rtdb/grammar/regex-limits.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
