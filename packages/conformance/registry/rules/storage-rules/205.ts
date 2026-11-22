import { row } from './section.ts';

export default row({
  order: 430,
  featureKeys: ["resource"],
  behavior: "`resource` binds `md5Hash`, `crc32c`, `etag`, `contentDisposition`, `contentEncoding`, `contentLanguage` and `cacheControl` from the stored object (ST-H1-1)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-resource-unmodeled-fields` (captured 2026-10-27, 9 cases) records production ALLOWING a rule that reads each of the seven fields' stored values and DENYING when absent, and `oracle:stdlib-realstorage-p2-native-object-fields` (`stored-exact`) confirms `resource` exposes `md5Hash`, `crc32c`, and `etag` from stored objects. The sandbox persists all four content headers plus RFC 1321 base64 `md5Hash`, 4-byte big-endian RFC 4648 base64 `crc32c` (matching `capture-s-wire.json` seq 6/7), and a deterministic synthetic version `etag` (wire captures redact production's opaque `etag` to `<etag>`), and `buildResourceObject` binds all seven on `resource`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["the evaluator denies reads and writes production allows on these fields"],
  oracleObservations: [
    "rules-storage-h1-resource-unmodeled-fields",
    "stdlib-realstorage-p2-native-object-fields",
  ],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/pyric/test/storage/sandbox/rules-resource-fields.test.ts",
    "packages/pyric/test/storage/native-object-fields-real-replay.test.ts",
  ],
  constructs: [
    "storage.binding.resource.md5Hash",
    "storage.binding.resource.crc32c",
    "storage.binding.resource.etag",
    "storage.binding.resource.contentDisposition",
    "storage.binding.resource.contentEncoding",
    "storage.binding.resource.contentLanguage",
    "storage.binding.resource.cacheControl",
  ],
});
