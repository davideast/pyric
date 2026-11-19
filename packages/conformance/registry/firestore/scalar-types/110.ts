import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["GeoPoint"],
  behavior: "`GeoPoint` round-trip through the sandbox wire encoder — `GeoPoint` written via `setDoc` reads back as a `GeoPoint` instance with the same latitude / longitude",
  evidence: "`unit:packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts` + `unit:packages/pyric/test/firestore/sandbox-target.test.ts` (\"Bytes + GeoPoint round-trip\"), oracle: `packages/conformance/observations/firestore/firestore-row-110-geopoint-roundtrip.json` — `setDoc({loc: new GeoPoint(37.7749, -122.4194)})` then `getDoc` yields `loc instanceof GeoPoint === true`, `loc.constructor.name === 'GeoPoint'`, `loc.latitude === 37.7749`, `loc.longitude === -122.4194` against digame-mas. Sandbox storage uses the rules `LatLng` wrapper; `pyric/firestore` finalizes reads into its locally owned `GeoPoint` class.",
  risk: ["specific-value","specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-110-geopoint-roundtrip"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts"],
});
