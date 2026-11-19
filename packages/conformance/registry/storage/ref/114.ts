import { row } from './section.ts';

export default row({
  order: 160,
  api: "ref(storage, url).bucket",
  behavior: "Production gives a reference on the URL's bucket, including a bucket other than the app's default. The sandbox's `ref()` keeps the handle's bucket, at the URL's path; `getStorage(app, bucketUrl)` reaches another bucket",
  status: "diverged-documented",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `gsOtherBucket` and `firebaseDownloadUrlOtherBucket` (`bucket: 'other-bucket'`) and `gsDefaultBucket` (`bucket: 'b'`, the configured bucket). `ref()` keeps the handle's bucket: a URL naming another bucket reads that path in the handle's bucket. To reach another bucket, an app opens it with `getStorage(app, bucketUrl)` (storage#11). The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`: both pin production's `other-bucket` beside the sandbox's bucket and the URL's `fullPath`.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts"],
  conformanceDisposition: "by-design",
});
