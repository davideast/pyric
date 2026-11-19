import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["getStorage"],
  behavior: "`getStorage(app, bucketUrl?)` caches one handle per `(app, bucketUrl)` spelling, opens the bucket the URL names with its own objects and deployed rules, rejects object-path URLs synchronously with `storage/invalid-default-bucket`, and reports the configured or requested bucket name on references and `FullMetadata`",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["client-storage-getstorage-bucket-url"],
  evidence: "`oracle:client-storage-getstorage-bucket-url` (`firebase` 12.19.0, `fetchCalls: 0`) locks per-spelling handle caching, independent retry times, `ref().bucket` and `toString()` resolution across `gs://`, `firebasestorage.googleapis.com/v0/b/<bucket>/o`, and bare bucket spellings, and synchronous `storage/invalid-default-bucket` rejection on URLs with object paths; replayed across in-process `oracle-conformance.test.ts` (`oracle-getstorage-bucket-url-cases.ts`), SharedWorker `storage-getstorage-bucket-url-parity.test.ts`, and Node-hosted SQLite `hosted-sqlite.test.ts` (`hosted-sqlite-getstorage-bucket-url-oracle.ts`). `unit:storage/sandbox/rules-bucket-name.test.ts` and `test/apps/storage-per-bucket-rules` verify configured `storageBucket` and named-bucket reporting on references and `FullMetadata` (#1519) plus per-bucket rules isolation (#1313) across hosted, `PYRIC_SANDBOX=remote`, SharedWorker, in-page, and `PYRIC_SANDBOX=local` planes while keeping `pyric-default` as the internal default store key and zero-config sandbox fallback.",
  conformanceTests: [
    "packages/pyric/test/storage/oracle-conformance.test.ts",
    "packages/cli/test/serve/worker/storage-getstorage-bucket-url-parity.test.ts",
    "packages/cli/test/serve/hosted-sqlite.test.ts",
    "packages/pyric/test/storage/service.test.ts",
    "packages/pyric/test/storage/per-bucket-rules.test.ts",
    "packages/pyric/test/storage/sandbox/rules-bucket-name.test.ts",
    "packages/cli/test/serve/storage-rules-install.test.ts",
    "test/apps/storage-per-bucket-rules/scenario.ts",
  ],
  notes:
    "By-design zero-config sandbox ergonomic (paired with storage#12): when both `options.storageBucket` and `bucketUrl` are omitted, production `firebase/storage` throws `storage/no-default-bucket` synchronously on `ref(storage)` (`client-storage-getstorage-bucket-url.unconfiguredStorageBucket.omitted`), whereas Pyric falls back to `'pyric-default'` so zero-config apps and sandboxes operate without requiring a bucket identifier.",
});
