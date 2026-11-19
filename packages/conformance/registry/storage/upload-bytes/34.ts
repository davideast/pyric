import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "Returned `metadata.bucket` matches the storage handle's bucket",
  evidence: "Production observation `storage-uploadbytes-payload-types` (firebase 12.19.0) records `metadataBucketMatchesHandle: true` across all three binary input shapes. Replayed across all three planes.",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-payload-types"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
