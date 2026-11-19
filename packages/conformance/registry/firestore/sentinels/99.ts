import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["serverTimestamp","Timestamp"],
  behavior: "`serverTimestamp()` resolves to a `Timestamp` after the write commits",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-99-servertimestamp-resolves` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-99-servertimestamp-resolves-to-timestamp.json` — `setDoc({at: serverTimestamp()})` then `getDoc` yields `at instanceof Timestamp === true`, `constructor.name === 'Timestamp'`, with both `.seconds` (number) and `.nanoseconds` (number) present.",
  risk: ["specific-field","sentinel"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-99-servertimestamp-resolves-to-timestamp"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
