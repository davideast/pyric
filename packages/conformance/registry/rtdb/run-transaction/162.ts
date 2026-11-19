import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Result snapshot's `.val()` reflects the committed value (or the existing value if aborted)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `snapVal: 1` matching the committed value.",
  risk: ["specific-field","atomicity"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-returns-committed-snapshot","rtdb-modular-runtransaction-success"],
  aliases: ["rtdb#162"],
});
