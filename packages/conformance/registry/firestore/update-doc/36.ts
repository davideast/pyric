import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Sentinels resolve mid-update (`increment(1)` against an existing numeric field, etc.)",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-sentinels`, oracle: `packages/conformance/observations/firestore/firestore-row-36-sentinels-in-updatedoc.json` — after `setDoc({count: 5, tags: ['a'], oldField: 'keep-then-remove'})` then `updateDoc({count: increment(3), tags: arrayUnion('b'), oldField: deleteField()})`, the follow-up `getDoc` returns `count: 8`, `tags: ['a', 'b']`, and `oldField` absent from the doc (the deleteField sentinel actually removes the key). All three sentinels apply in one mid-update commit.",
  risk: ["specific-field","sentinel"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-36-sentinels-in-updatedoc"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
