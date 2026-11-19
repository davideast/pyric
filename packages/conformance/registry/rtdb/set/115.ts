import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Rules-denied write throws plain `Error` with `code: 'PERMISSION_DENIED'` (same shape as #110)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json`",
  risk: ["specific-field","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-denied-error-code"],
  aliases: ["rtdb#115"],
});
