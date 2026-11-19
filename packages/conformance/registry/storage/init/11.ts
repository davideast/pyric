import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["getStorage"],
  behavior: "`getStorage(app, bucketUrl?)` opens the bucket the URL names, with its own objects and the rules deployed to it; the app's default bucket is stored under the key `pyric-default`",
  status: "diverged-documented",
  evidence: "Package resolution owns production selection. `unit:service.test.ts` pins a bucket URL other than the app's `storageBucket` opening its own bucket, and the default bucket's store key `pyric-default`; `unit:storage/per-bucket-rules.test.ts` pins each bucket's objects and rules apart. `test/apps/storage-per-bucket-rules` uploads to the default bucket, `gs://media-bucket` and an undeployed bucket from the page on the Node host, the SharedWorker and the in-page sandbox, and from server scripts attached to the Node host and under `PYRIC_SANDBOX=local`, and each enforces the file `firebase.json` deploys to it (#1313). The in-page plane still reports the default bucket as `pyric-default` in metadata and references (#1519).",
  conformanceTests: ["packages/pyric/test/storage/service.test.ts","packages/pyric/test/storage/per-bucket-rules.test.ts","packages/cli/test/serve/storage-rules-install.test.ts","test/apps/storage-per-bucket-rules/scenario.ts"],
});
