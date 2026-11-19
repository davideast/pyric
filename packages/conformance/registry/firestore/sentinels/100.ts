import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["increment"],
  behavior: "`increment(n)` atomically bumps a numeric field; `null`/missing field starts from 0",
  evidence: "`unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-100-increment-bumps-numeric` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-100-increment-bumps-numeric.json` — `setDoc` with no `count` field then `updateDoc({count: increment(5)})` yields `count === 5` (starts from 0). Follow-up `increment(3)` → 8, then `increment(-2)` → 6 (negative deltas apply, increments accumulate). Merge-create + int↔double + batch-across-docs: `unit:upstream-transform-txn-listener-probes.test.ts`",
  risk: ["specific-field","sentinel","atomicity"],
  riskScore: 5,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-100-increment-bumps-numeric"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/upstream-transform-txn-listener-probes.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
