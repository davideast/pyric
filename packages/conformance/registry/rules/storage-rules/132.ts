import { row } from './section.ts';

export default row({
  order: 320,
  featureKeys: ["parseStorageRules", "evaluateStorageRules", "request.resource.size", "request.resource.contentType"],
  behavior: "The service-scoped `storage/uploads`, `storage/metadata`, `storage/objects`, and `storage/time` modules resolve through `2+modules` and preserve their production upload-bound, MIME, metadata, operation-identity, and strict timestamp-window semantics",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-21: one bounded Rules Test API batch captures 15 verdicts for the exact 13 deployable function bodies in the four shipped modules (`oracle:rules-storage-stdlib-storage-modules`). A separately authored, explicitly reconstructed normalized-AST digest locks the captured corpus bodies, and the source-lock test requires the shipped functions of the same names to remain AST-identical. The generic Storage stdlib fixture runner and oracle replay execute those bodies locally; resolver tests prove the modules are admitted only for `firebase.storage`, lower to plain v2, and fail closed under Firestore. The module surface excludes the advanced integrity and metadata-diff candidates. UPDATED, 2026-09-28: Storage module functions may call `firestore.get()` and `firestore.exists()` within production's limit of two distinct Firestore documents per request. `storage/objects` adds `nameSegment(index)` and `matchesDocument(path, field)`; `matchesDocument` passes a path argument to `firestore.get()` and reads one document per call. `oracle:rules-storage-resource-object-identity` (row #116) captures the `request.resource.name` and `split('/')` index shapes they rely on, and the module replay `test/rules/modules/fixtures/stdlib-replay-storage-objects.json` records production agreeing with all 26 `storage/objects` cases, checked by `unit:conformance/firestore-stdlib-replay.test.ts`; `unit:conformance/storage-stdlib-source-lock.test.ts` requires that replay for every shipped function outside the captured batch.",
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-stdlib-storage-modules"],
  conformanceTests: [
    "packages/conformance/test/src/storage-stdlib-source-lock.test.ts",
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/stdlib-cases.test.ts",
    "packages/rules/test/storage/stdlib.test.ts",
  ],
  constructs: [
    "storage.binding.request.auth",
    "storage.binding.request.method",
    "storage.binding.request.resource.size",
    "storage.binding.request.resource.contentType",
    "storage.binding.request.resource.metadata",
    "storage.binding.request.time",
    "storage.binding.resource.metadata",
    "storage.binding.resource.timeCreated",
    "storage.binding.resource.updated",
    "storage.function.duration.value",
    "storage.method.map.keys",
    "storage.method.set.hasAll",
    "storage.method.string.matches",
    "storage.operator.in",
    "storage.operator.is",
  ],
});
