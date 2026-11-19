import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["getDownloadURL"],
  api: "getDownloadURL(file)",
  behavior: "For a file without a download token, `getDownloadURL` mints a UUID into `firebaseStorageDownloadTokens`, and later calls keep it",
  evidence: "Replayed by the pyric-admin conformance suite on the in-process arm and on a SharedWorker host, and by the hosted replay on the Node host, against production observation `admin-storage-metadata-download-url` (`afterSave.hasDownloadTokens: false`; `getDownloadURLWithoutToken`: `threw: false`, `mintsTokenIntoMetadata: true`, `mintedTokenIsUuid: true`; the hosted replay also matches `urlCarriesMintedToken: true`). All three mint a UUID and keep it on later calls.",
  status: "conforms",
  automation: "oracle-backed",
  risk: ["specific-value", "metadata"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)", "asserts metadata shape"],
});
