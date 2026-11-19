import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Initial fire for a missing doc has `exists() === false` and `data() === undefined`",
  evidence: "`playground:firestore-onsnapshot` (bundled) + `playground:firestore-row-82-onsnapshot-missing-initial` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-82-onsnapshot-missing-initial.json` — single initial fire with `snap.exists() === false`, `snap.data() === undefined`, `hasPendingWrites: false`, `fromCache: false`. The missing-doc fire is server-confirmed, not a cache speculation.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-82-onsnapshot-missing-initial"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
