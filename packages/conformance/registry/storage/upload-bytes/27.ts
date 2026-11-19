import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "ContentType precedence: caller's `metadata.contentType` > `Blob.type` > `application/octet-stream`",
  evidence: "Production observation `storage-uploadbytes-contenttype-precedence` (firebase 12.19.0) records `typedBlobCallerOverride` (`application/pdf` overriding `image/png`), `typedBlobNoHint` (`image/png`), and `uint8NoHint` (`application/octet-stream`) across both `UploadResult.metadata` and `getMetadata()`. Replayed across all three planes.",
  risk: ["specific-value","metadata"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-contenttype-precedence"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
