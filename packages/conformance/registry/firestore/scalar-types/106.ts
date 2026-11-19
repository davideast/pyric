import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Bytes","GeoPoint","FieldPath","documentId"],
  automation: "oracle-backed",
  behavior: "The sandbox mirror owns compatible scalar constructors — `Bytes.fromUint8Array(...)`, `new GeoPoint(lat, lng)`, `new FieldPath(...)`, and `documentId()` — without importing `firebase/firestore`",
  evidence: "`unit:sandbox-target.test.ts` (constructibility + round trips), `package-edge:package-dependencies.test.ts`, `oracle:firestore-scalar-bytes-geopoint-vector-roundtrip`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["firestore-scalar-bytes-geopoint-vector-roundtrip"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/cli/test/package-dependencies.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
