import { row } from './section.ts';

export default row({
  order: 500,
  featureKeys: ["String"],
  status: "conforms",
  behavior: "Pyric's load-time check refuses `(a{1000}){1000}` with production's \"could not determinize efficiently\" text, without building its million states",
  evidence: "`oracle:rules-rtdb-r60-deploy-regex-repeat-of-repeat` (captured 2026-10-27 on pyric-oracle-rtdb-2, 1 dry-run deploy case) records production REJECTING `/^(a{1000}){1000}$/` with \"Illegal regular expression, could not determinize efficiently\". pyric counts positions while it parses and refuses before any matcher is built. Found in #1247 stream S1.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts a nested repeat too large to determinize fails at load with production's text"],
  oracleObservations: ["rules-rtdb-r60-deploy-regex-repeat-of-repeat"],
  conformanceTests: ["packages/conformance/src/rules-rtdb-replay.test.ts", "packages/rules/test/rtdb/grammar/regex-limits.test.ts"],
  constructs: ["rtdb.semantic.regex-literal"],
});
