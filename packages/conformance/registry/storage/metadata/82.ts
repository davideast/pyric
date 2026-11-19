import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["updateMetadata"],
  behavior: "`updateMetadata(ref, patch)` updates listed client-settable fields and merges `customMetadata` keys per RFC 7396",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-updatemetadata-fields-and-bytes.json` + `unit:metadata.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-updatemetadata-fields-and-bytes"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
