import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Idempotent — `deleteDoc` on missing doc resolves without throwing (matches JS SDK)",
  evidence: "`unit:deletedoc-missing.test.ts`, `playground:firestore-deletedoc-missing`, oracle: `packages/conformance/observations/firestore/firestore-deletedoc-missing.json`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-deletedoc-missing"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
