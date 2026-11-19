import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["compileRtdbRules","serializeRtdbRules"],
  api: "compileRtdbRules / serializeRtdbRules",
  behavior: "`.indexOn` arrays preserved across the round-trip",
  evidence: "Oracle `rtdb-rules-json-wildcard-and-indexon-roundtrip`; `unit:compiled-rules.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-json-wildcard-and-indexon-roundtrip"],
  conformanceTests: ["packages/rules/test/rtdb/compiled-rules.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
