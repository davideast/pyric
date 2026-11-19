import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["getDownloadURL"],
  api: "GET <download URL>",
  behavior: "The download URL answers a `GET` with no credentials with the object's bytes and content type, and a `Range` request with 206 and `Content-Range`",
  evidence: "Production observation `admin-storage-metadata-download-url` records `unauthenticatedGet` (200, `audio/wav`, `bytesMatch: true`) and `rangeGet` (206, `bytes 2-5/64`, `bytesMatch: true`). On the Node host the hosted replay matches both. In process and on a SharedWorker host there is no HTTP origin, so a download URL is a `data:<contentType>;base64,...` URI that carries the bytes; its `GET` matches, but it answers a `Range` request with 200 and every byte, which the pyric-admin conformance suite pins beside the production answer.",
  status: "diverged-documented",
  automation: "oracle-backed",
  conformanceDisposition: "by-design",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
});
