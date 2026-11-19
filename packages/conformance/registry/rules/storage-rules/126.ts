import { row } from './section.ts';

export default row({
  order: 260,
  featureKeys: ["evaluateStorageRules", "request.resource.size", "request.resource.contentType"],
  behavior: "Storage-native upload primitives at security boundaries: inclusive byte maximums, exact and whole-string MIME checks, metadata-only updates with unchanged bytes/owner, string path wildcards, generation/metageneration identity, and strict creation-time windows. A client upload is evaluated as `create` whether or not an object exists at the path, with `resource` bound to the stored object when one does; a metadata update is evaluated as `update`. A real upload or metadata update builds `request.resource` with the object's `name` (full object path) and `bucket`, its settable content fields (a client upload that sets no `contentDisposition` stores `inline; filename*=utf-8''<file>`, the file name percent-encoded per RFC 5987, and an admin-plane write stores none; an unset `contentEncoding` reads as `identity` on both writes and in a client metadata read; other unset fields and `metadata` are null), null `generation`/`metageneration`/`etag` on an upload, the stored `generation`/`metageneration` on a metadata update, and no `timeCreated` or `updated`",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-20: `oracle:rules-storage-upload-primitives-boundaries` captures 26 production cases in one Rules Test API request. The local evaluator matches every case scoped to this row: size 0/exact/+1, MIME exact/case/parameter and regex anchoring, metadata update invariants, filename wildcard typing, exact/absent generation identity, and request.time just before/at/after a strict 60-second boundary plus a future timeCreated fixture. Metadata collection methods and missing request.resource are separated into divergence rows #127/#128 rather than contaminating this credit. Extended 2026-09-27: the Rules Test API takes `request.resource` as input, so it cannot show which fields production builds. `oracle:stdlib-realstorage-request-resource-fields` deploys 182 probe rules to a real bucket and records production verdicts under real client uploads to new paths, metadata updates, and uploads over existing objects: presence, type, and value of every documented field, key membership, and key count. It also reads back the content fields of client uploads that set or leave unset `contentDisposition` and `contentEncoding` (including a file name that needs percent-encoding) and of an object written through the GCS JSON API, through both the GCS JSON API and the Firebase Storage endpoint, and records metadata updates over objects each API wrote. On an upload over an existing object production allows under `allow create`, denies under `allow update`, and binds `resource` to the stored object (`resource.size` is the stored size while `request.resource.size` is the new size). `unit:storage/request-resource-real-replay.test.ts` deploys the same rules to a sandbox, makes the same writes through the Storage SDK, and matches every verdict and read-back this row claims. It pins 25 divergences outside this row's claim: the sandbox does not carry `md5Hash`, `crc32c`, `storageClass`, or a metadata update's `etag`. `unit:storage/enforce.test.ts`, `unit:storage/resumable-upload.test.ts`, and `unit:storage/sandbox/rules-resources.test.ts` cover the upload, resumable upload, and metadata-update call sites and the binding; `packages/cli/test/serve/worker/storage-chunked-commit.test.ts` covers the chunked upload's check at begin and at commit.",
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-upload-primitives-boundaries", "stdlib-realstorage-request-resource-fields"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/pyric/test/storage/request-resource-real-replay.test.ts",
    "packages/pyric/test/storage/enforce.test.ts",
    "packages/pyric/test/storage/resumable-upload.test.ts",
    "packages/pyric/test/storage/sandbox/rules-resources.test.ts",
    "packages/cli/test/serve/worker/storage-chunked-commit.test.ts",
  ],
  constructs: [
    "storage.binding.request.resource.size",
    "storage.binding.request.resource.contentType",
    "storage.binding.request.resource.metadata",
    "storage.binding.request.time",
    "storage.binding.resource.metadata",
    "storage.binding.resource.name",
    "storage.binding.resource.timeCreated",
    "storage.binding.resource.bucket",
    "storage.binding.resource.generation",
    "storage.binding.resource.metageneration",
    "storage.function.duration.value",
    "storage.method.string.matches",
    "storage.operator.is",
  ],
});
