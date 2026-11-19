import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getDownloadURL"],
  api: "getDownloadURL(file)",
  behavior: "Returns `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded path>?alt=media&token=<token>`, whose token is the file's `firebaseStorageDownloadTokens` custom metadata. The Firebase metadata endpoint, which client SDKs read, reports the same token as `downloadTokens` and leaves it out of `metadata`",
  evidence: "Production observation `admin-storage-metadata-download-url` records `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded path>?alt=media&token=<token>`, the token equal to `firebaseStorageDownloadTokens`, and the Firebase metadata endpoint reporting it as `downloadTokens` outside `metadata`. On the Node host the hosted replay matches the path after the `/__pyric/storage` prefix, `alt=media`, the query keys, the token, and the client view's `downloadTokens`; the origin is the host's own `http` origin. In process and on a SharedWorker host there is no HTTP origin, so the URL is a `data:<contentType>;base64,...` URI that carries the bytes; the pyric-admin conformance suite pins it beside the production form. It diverges because only the Node host serves bytes over HTTP.",
  status: "diverged-documented",
  automation: "oracle-backed",
  conformanceDisposition: "by-design",
  risk: ["specific-value", "specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 2 specific value(s)", "asserts a specific field/property value"],
});
