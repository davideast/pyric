import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Sentinels (`serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`) resolve in the same call",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-sentinels`, oracle: `packages/conformance/observations/firestore/firestore-row-30-sentinels-in-setdoc.json` — `setDoc({createdAt: serverTimestamp(), count: 5, tags: ['a']})` followed by `getDoc` returns `createdAt` as a `Timestamp` instance (constructor name `Timestamp`, has `seconds` + `nanoseconds`), `count === 5` (number), `tags === ['a']`. Sentinels resolve server-side and the follow-up read sees concrete values, not the sentinel placeholders.",
  risk: ["specific-field","sentinel"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-30-sentinels-in-setdoc"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
