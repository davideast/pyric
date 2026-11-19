import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Rules-denied read throws a plain `Error` (NOT a `FirebaseError`) with `code: 'PERMISSION_DENIED'` (uppercase snake-case) — matches the agent-tool rows #15/#20",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json`",
  risk: ["specific-field","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts rules-denial behavior"],
  oracleObservations: ["rtdb-rules-denied-error-code"],
  aliases: ["rtdb#110"],
});
