import { row } from './section.ts';

export default row({
  order: 130,
  behavior: "Prod: round-trips uploaded bytes through `getDownloadURL` + fetch (byte-for-byte equality)",
  statusNote: "(prod-only)",
  evidence: "oracle: `packages/conformance/observations/storage/storage-upload-bytes-roundtrip.json` (against digame-mas, fb-js-sdk 12.19.0: 6-byte payload -> uploadBytes -> getDownloadURL -> HTTPS fetch -> `bytesMatch: true`, `urlIsHttps: true`, `bodyLen === payloadLen === 6`). This row records the production answer key; row #51 compares the sandbox's URL forms, hosted and in-process, against it.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["storage-upload-bytes-roundtrip"],
});
