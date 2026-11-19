import { row } from './section.ts';

export default row({
  order: 330,
  featureKeys: ["request.time", "timestamp.value"],
  behavior: "Timestamp `seconds()` and `nanos()` are time-of-day components like `hours()` and `minutes()`: the seconds of the minute and the nanoseconds of the second. `toMillis()` is the epoch accessor, and `timestamp.value(-1500)` reads year 1969, seconds 58, and nanos 500000000",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "CONFORMS, 2026-09-24: `oracle:rules-firestore-timestamp-component-accessors` captures production reading `request.time.seconds()` as 30 at 13:45:30.250 and denying the epoch-seconds reading, `nanos()` as 250000000, and the components of a pre-epoch timestamp. The Storage capture rules-storage-stdlib-timestamp-duration records the same values under `firebase.storage` (row storage-rules#storage.stdlib.timestamp-duration). The shared Timestamp wrapper reads `seconds()` as the seconds of the minute; `unit:rules/oracle-conformance.test.ts` replays all 5 verdicts and `unit:rules/simulator/wrappers/timestamp.test.ts` pins the components, including a pre-epoch timestamp.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 3 specific value(s)"],
  oracleObservations: ["rules-firestore-timestamp-component-accessors"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/wrappers/timestamp.test.ts",
  ],
  constructs: ["firestore.method.timestamp.seconds", "firestore.method.timestamp.nanos", "firestore.method.timestamp.toMillis"],
});
