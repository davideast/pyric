import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["File.setMetadata", "getDownloadURL"],
  api: "file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } })",
  behavior: "Removing `firebaseStorageDownloadTokens` revokes the download URL: a `GET` of it answers 403, and the next `getDownloadURL` mints a new token whose URL answers 200",
  evidence: "Production observation `admin-storage-metadata-download-url` records `revocation`: `tokenRemoved: true`, `revokedUrlStatus: 403`, `getDownloadURLAfterRevoke.mintsNewToken: true`, `newUrlStatus: 200`. On the Node host the hosted replay matches all four. In process and on a SharedWorker host there is no HTTP origin, so a download URL is a `data:<contentType>;base64,...` URI that carries the bytes; removing the token and minting another match, but a `data:` URI cannot be revoked and still resolves, which the pyric-admin conformance suite pins beside the production status.",
  status: "diverged-documented",
  automation: "oracle-backed",
  conformanceDisposition: "by-design",
  risk: ["specific-value", "error-code"],
  riskScore: 4,
  riskReasons: ["asserts 2 specific value(s)", "asserts an HTTP status"],
});
