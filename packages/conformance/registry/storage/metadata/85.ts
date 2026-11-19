import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["updateMetadata"],
  behavior: "`updateMetadata` preserves the blob bytes (only metadata changes)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-updatemetadata-fields-and-bytes.json` + `unit:metadata.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-updatemetadata-fields-and-bytes"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
