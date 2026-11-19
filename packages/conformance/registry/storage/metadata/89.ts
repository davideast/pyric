import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["getMetadata"],
  behavior: "Prod: `getMetadata` after `uploadBytes` returns `contentType` and `size` matching what was uploaded",
  status: "conforms",
  statusNote: "(prod-only)",
  evidence: "oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (against digame-mas, fb-js-sdk 12.19.0: upload 128-byte payload with `contentType: 'application/octet-stream'`, getMetadata returns `metadataSize: 128`, `metadataContentType: 'application/octet-stream'`, `metadataBucket: 'digame-mas.appspot.com'`, `metadataMetageneration: '1'`, `fullPathMatches: true`)",
  risk: ["specific-field","metadata"],
  riskScore: 2,
  riskReasons: ["asserts a specific field/property value","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-upload-then-getmetadata"],
  conformanceTests: ["packages/pyric/test/storage/persistence-state.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
