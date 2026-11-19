import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["vector","VectorValue"],
  automation: "oracle-backed",
  behavior: "Vector value type (`vector()` + `VectorValue`) round-trip: a vector written via `setDoc` reads back as a `VectorValue` with the same components",
  evidence: "`unit:sandbox-target.test.ts` (\"Bytes + GeoPoint + VectorValue round-trip\", top-level + nested), `oracle:firestore-scalar-bytes-geopoint-vector-roundtrip`. The locally owned `vector()` / `VectorValue` preserve Firebase's observable value shape; the sandbox converter stores the rules `Vector` wrapper and `pyric/firestore` finalizes reads back to `VectorValue`. **CLIENT surface only:** the web SDK exposes `vector()` + `VectorValue` (read/write) but has NO `findNearest` and NO `FieldValue.vector`; vector SEARCH is admin/server-only (`firebase-admin` `Query`/`CollectionReference.findNearest` + `FieldValue.vector()`), out of scope for this client matrix; the admin surface is tracked in the design rationale.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 3 specific value(s)"],
  oracleObservations: ["firestore-scalar-bytes-geopoint-vector-roundtrip"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
