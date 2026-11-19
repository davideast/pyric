import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["increment","arrayUnion","arrayRemove"],
  automation: "oracle-backed",
  rowNumber: 105,
  behavior: "**Sentinel overwrite on type mismatch (FS-B11)** — `increment(n)` on a non-numeric (or absent) prior OVERWRITES using a base value of 0 (result `n`); `arrayUnion`/`arrayRemove` on a non-array prior coerce the base to `[]`. Pre-FS-B11 these threw and surfaced as `invalid-argument` denials. Mirrors `clones/.../model/transform_operation.ts` (`computeTransformOperationBaseValue`, `coercedFieldValuesArray`).",
  evidence: "`unit:simulator/converters/fieldvalue.test.ts` (FS-B11 overwrite block + flipped unit/integration/batch cases; verified failing pre-fix), `oracle:firestore-sentinel-type-mismatch-overwrite`",
  risk: ["specific-value","error-code","sentinel","atomicity"],
  riskScore: 9,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `invalid-argument`","asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity"],
  oracleObservations: ["firestore-sentinel-type-mismatch-overwrite"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/simulator/converters/fieldvalue.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
