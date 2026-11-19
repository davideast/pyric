import { row } from './section.ts';

export default row({
  order: 250,
  featureKeys: ["get"],
  behavior: "Rules-denied read throws the same plain-`Error` `PERMISSION_DENIED` shape as a denied write",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"rules-denied get throws the same plain Error shape\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json`",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-denied-error-code"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", "packages/pyric/test/database/denial-context.test.ts"],
  rowNumber: 24,
});
