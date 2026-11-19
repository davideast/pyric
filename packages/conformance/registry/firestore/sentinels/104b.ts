import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["Timestamp"],
  automation: "oracle-backed",
  rowNumber: 104,
  behavior: "**`Timestamp` nanos normalization + value API (FS-B12)** — `fromMillis`/`fromDate`/`now` derive `nanoseconds` as `floor((ms - seconds*1000) * 1e6)` so it is always non-negative; `fromMillis(-500).toMillis()` round-trips to -500 (was -1500). The class ships `isEqual` / `toString` / `toJSON` / `valueOf`, mirroring `clones/.../lite-api/timestamp.ts`.",
  evidence: "`unit:admin-compat/timestamp-api.test.ts` (negative-millis round-trip + value API; pre-fix lacked the methods and mis-normalized), `oracle:firestore-timestamp-roundtrip-and-negative-millis`",
  oracleObservations: ["firestore-timestamp-roundtrip-and-negative-millis"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/admin-compat/timestamp-api.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
