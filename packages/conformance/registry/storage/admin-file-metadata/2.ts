import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["File.setMetadata"],
  api: "file.setMetadata({ metadata: { key: null } })",
  behavior: "A custom metadata key set to `null` is removed; the other keys, including `firebaseStorageDownloadTokens`, stay",
  evidence: "Replayed by the pyric-admin conformance suite on the in-process arm and on a SharedWorker host, and by the hosted replay on the Node host, against production observation `admin-storage-metadata-download-url` (`nullRemovesKey.noteRemoved: true`, `nullRemovesKey.tokenKept: true`). All three match.",
  status: "conforms",
  automation: "oracle-backed",
  risk: ["specific-field", "metadata"],
  riskScore: 2,
  riskReasons: ["asserts a specific field/property value", "asserts metadata shape"],
});
