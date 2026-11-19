import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["serverTimestamp"],
  behavior: "`serverTimestamp()` as a field value in `set` or `update` writes the `{\".sv\": \"timestamp\"}` sentinel; the read-back value is the resolved number",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` — read-back showed `createdAtSentinelShape: false` (sentinel resolved server-side; client sees the number, not the `.sv` placeholder).",
  risk: ["specific-field","sentinel"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-servertimestamp-resolves"],
  aliases: ["rtdb#154"],
});
