import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["serverTimestamp","Timestamp"],
  automation: "oracle-backed",
  rowNumber: 104,
  behavior: "**Unified Timestamp storage (FS-B4)** — a `Timestamp` written directly via the modular SDK (`setDoc({createdAt: Timestamp.now()})`) is stored as the same rules-internal `Timestamp` that `serverTimestamp()`/`Date` resolve to. Pre-FS-B4 a user-written `Timestamp` was the compat class only (not a `RulesValue`), so `request.resource.data.createdAt is timestamp` returned **false** for it while a `serverTimestamp()` write passed the same rule, and the two paths stored two different classes. A write-boundary converter now normalizes both.",
  evidence: "`unit:firestore/sandbox-converters/user-timestamp.test.ts` (`is timestamp` passes for a user Timestamp; unified storage class; range-filter regression guard -- verified failing pre-fix by removing the converter registration), `oracle:firestore-timestamp-roundtrip-and-negative-millis`",
  risk: ["sentinel"],
  riskScore: 2,
  riskReasons: ["asserts sentinel or atomic transform semantics"],
  oracleObservations: ["firestore-timestamp-roundtrip-and-negative-millis"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-converters/user-timestamp.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
