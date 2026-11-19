import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Returning `undefined` from the update fn **aborts** the transaction — resolves `{ committed: false }`, no write performed (RTDB-specific; distinct from Firestore where the only abort path is throwing)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json` — seeded `100` then transaction returned `undefined`; observed `committed: false, snapVal: null, afterValOnServer: 100` (existing value preserved).",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-abort-undefined"],
  aliases: ["rtdb#159"],
});
