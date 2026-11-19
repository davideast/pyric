import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["serverTimestamp"],
  behavior: "`serverTimestamp()` resolves server-side to a **number** (epoch milliseconds) — diverges from Firestore's `Timestamp` instance",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` — observed `createdAtType: 'number', createdAt: 1779075391118` (i.e. a plain JS number, NOT a `Timestamp` object).",
  risk: ["sentinel"],
  riskScore: 2,
  riskReasons: ["asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-servertimestamp-resolves"],
  aliases: ["rtdb#153"],
});
