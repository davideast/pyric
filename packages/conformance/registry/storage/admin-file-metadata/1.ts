import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["File.setMetadata", "File.getMetadata"],
  api: "file.setMetadata(metadata) / file.getMetadata()",
  behavior: "`setMetadata({ metadata: { key: value } })` stores custom metadata and advances `metageneration`; `getMetadata()` returns the keys under `metadata`, and a file saved without any has no `metadata` field",
  evidence: "Replayed by the pyric-admin conformance suite on the in-process arm and on a SharedWorker host, and by the hosted replay on the Node host, against production observation `admin-storage-metadata-download-url` (`afterSave.customMetadata: null`, `afterSet.customMetadata.note: 'first'`, `metagenerationAdvanced: true`, `setMetadataResolvesWithMetadata: true`). All three match.",
  status: "conforms",
  automation: "oracle-backed",
  risk: ["specific-field", "metadata"],
  riskScore: 2,
  riskReasons: ["asserts a specific field/property value", "asserts metadata shape"],
});
