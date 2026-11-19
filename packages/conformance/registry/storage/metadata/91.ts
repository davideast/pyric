import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["getMetadata","updateMetadata"],
  behavior: "`FullMetadata.md5Hash` populated on uploads",
  status: "conforms",
  evidence: "`oracle:storage-getstorage-handle-and-md5` (`emptyPayloadMd5OnUpload: '1B2M2Y8AsgTpgAmY7PhCfg=='`, `fourBytePayloadMd5OnUpload: 'CNbAWiFRKnmh3+udKo8mLw=='` matching `getMetadata`) and `oracle:storage-upload-then-getmetadata` (`hasMd5Hash: true`), replayed across `oracle-conformance.test.ts`, `storage-resumable-metadata-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-field","metadata"],
  riskScore: 2,
  riskReasons: ["asserts a specific field/property value","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-getstorage-handle-and-md5","storage-upload-then-getmetadata"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-resumable-metadata-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts"],
});
