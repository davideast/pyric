import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["Bytes"],
  behavior: "`Bytes` round-trip through the sandbox wire encoder — `Bytes` written via `setDoc` reads back as a `Bytes` instance with the same base64 representation",
  evidence: "`unit:packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts` + `unit:packages/pyric/test/firestore/sandbox-target.test.ts` (\"Bytes + GeoPoint round-trip\"), oracle: `packages/conformance/observations/firestore/firestore-row-109-bytes-roundtrip.json` — `setDoc({payload: Bytes.fromUint8Array([1,2,3,4])})` then `getDoc` yields `payload instanceof Bytes === true`, `payload.constructor.name === 'Bytes'`, `payload.toBase64() === 'AQIDBA=='`, and `payload.toUint8Array()` returns `[1,2,3,4]` against digame-mas. The sandbox converter stores the rules `Bytes` wrapper; `pyric/firestore` finalizes reads into its locally owned `Bytes` class with the same observed methods and values.",
  risk: ["specific-value","specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-109-bytes-roundtrip"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts"],
});
