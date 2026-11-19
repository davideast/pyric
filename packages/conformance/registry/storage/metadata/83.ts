import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["updateMetadata"],
  behavior: "`updateMetadata` bumps `metageneration` by 1 on each call",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-updatemetadata-versioning-and-timestamps.json` + `unit:metadata.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-updatemetadata-versioning-and-timestamps"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
