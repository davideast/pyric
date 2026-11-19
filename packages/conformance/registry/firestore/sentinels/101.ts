import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["arrayUnion"],
  behavior: "`arrayUnion(...values)` de-dupes against existing members **and** against duplicate args within the same call",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-101-arrayunion-dedupes` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-101-arrayunion-dedupes.json` — `setDoc({tags: ['a','b']})` then `updateDoc({tags: arrayUnion('b','c')})` yields `['a','b','c']` (single `b`, not double). Follow-up `updateDoc({tags: arrayUnion('d','d','a')})` yields `['a','b','c','d']` — both inline duplicate args and existing-member duplicates are de-duped. Merge-path + object members: `unit:upstream-transform-txn-listener-probes.test.ts`",
  risk: ["specific-field","sentinel"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-101-arrayunion-dedupes"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/upstream-transform-txn-listener-probes.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
