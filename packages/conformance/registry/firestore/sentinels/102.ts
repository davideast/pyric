import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["arrayRemove"],
  behavior: "`arrayRemove(...values)` strips matching members; values not present in the array are silent no-ops",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-102-arrayremove-strips` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-102-arrayremove-strips.json` — `setDoc({tags: ['a','b','c']})` then `updateDoc({tags: arrayRemove('b','d')})` yields `['a','c']`: `'b'` removed, `'d'` (absent) was a silent no-op (no error). Merge-path: `unit:upstream-transform-txn-listener-probes.test.ts`",
  risk: ["specific-value","specific-field","sentinel"],
  riskScore: 5,
  riskReasons: ["asserts 2 specific value(s)","asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-102-arrayremove-strips"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/upstream-transform-txn-listener-probes.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
