import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["updateMetadata"],
  behavior: "`updateMetadata` with `undefined` field values preserves the prior value, while `null` clears writable fields and `customMetadata` entries/maps",
  status: "conforms",
  evidence: "`oracle:storage-updatemetadata-undefined-and-null-clear` (`undefined` preserves `cacheControl`, `contentDisposition`, and `customMetadata`; `null` clears scalar fields and `customMetadata` keys/maps) + `unit:metadata.test.ts`, replayed across `oracle-conformance.test.ts`, `storage-resumable-metadata-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-updatemetadata-undefined-and-null-clear"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-resumable-metadata-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/metadata.test.ts"],
});
