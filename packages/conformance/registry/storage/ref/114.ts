import { row } from './section.ts';

export default row({
  order: 160,
  api: "ref(storage, url).bucket",
  behavior: "`ref(storage, url)` places the reference on the URL's bucket, including a bucket other than the handle's default, preserving `ref.storage === storage` while routing reads, writes, metadata, listings, deletions, and per-bucket Security Rules to that bucket",
  status: "conforms",
  evidence: "Production observation `client-storage-ref-urls` (`firebase` 12.19.0) records `gsOtherBucket` and `firebaseDownloadUrlOtherBucket` (`bucket: 'other-bucket'`) alongside `gsDefaultBucket` (`bucket: 'b'`, the configured default bucket). Replayed unpinned across in-process `oracle-conformance.test.ts`, SharedWorker `storage-ref-urls.test.ts`, and Node-hosted SQLite `hosted-sqlite.test.ts` (`hosted-sqlite-getstorage-bucket-url-oracle.ts`), with multi-plane data and per-bucket Security Rules isolation verified in `cross-bucket-target.test.ts` and `test/apps/storage-per-bucket-rules/scenario.ts` across hosted, `PYRIC_SANDBOX=remote`, SharedWorker, in-page, and `PYRIC_SANDBOX=local` runtimes.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: [
    "packages/pyric/test/storage/oracle-conformance.test.ts",
    "packages/pyric/test/storage/sandbox/cross-bucket-target.test.ts",
    "packages/cli/test/serve/worker/storage-ref-urls.test.ts",
    "packages/cli/test/serve/hosted-sqlite.test.ts",
    "test/apps/storage-per-bucket-rules/scenario.ts",
  ],
});
