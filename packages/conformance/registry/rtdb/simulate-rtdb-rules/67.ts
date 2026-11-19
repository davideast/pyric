import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "An expression that fails to parse (`parsed.valid === false`) produces an unsupported result rather than silently granting or fabricating a deny",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-type-check` (`snapshot-index-method-name`) and `rtdb-rules-deploy-refusals` (`matches with an unterminated character class`) record unparseable expressions evaluating as `unsupported: true` across `simulateRtdbRules` and `rtdbRules(...).simulate` alongside `unit:simulation/handler.test.ts`.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-type-check", "rtdb-rules-deploy-refusals"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/conformance/test/rtdb-rules/capture-stdlib-and-deploy-refusals.test.ts"],
});
