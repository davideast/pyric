import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "Returned `metadata.fullPath` matches the ref's `fullPath`",
  evidence: "Production observation `storage-uploadbytes-payload-types` (firebase 12.19.0) records `metadataFullPathMatchesTarget: true` across `Blob`, `Uint8Array`, and `ArrayBuffer` uploads. Replayed across all three planes.",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-payload-types"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
