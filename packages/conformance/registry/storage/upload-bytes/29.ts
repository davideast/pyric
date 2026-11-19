import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "`customMetadata` round-trips through the upload pipeline (and is omitted when unset)",
  evidence: "Production observation `storage-uploadbytes-custom-metadata` (firebase 12.19.0) records `withoutCustomMetadata` (`uploadHasCustomMetadataProperty: false`, `customMetadata === undefined`) and `withCustomMetadata` (`{ owner: 'user-1', emptyValue: '', label: 'alpha release' }` across `UploadResult.metadata` and `getMetadata()`). `toFullMetadata` omits `customMetadata` when unset; replayed across all three planes.",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-custom-metadata"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/metadata.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
