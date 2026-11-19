import { row } from './section.ts';

export default row({
  order: 430,
  featureKeys: ["resource"],
  behavior: "`resource` binds `md5Hash`, `crc32c`, `etag`, `contentDisposition`, `contentEncoding`, `contentLanguage` and `cacheControl` from the stored object (ST-H1-1)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-resource-unmodeled-fields` (captured 2026-10-27, 9 cases) records production ALLOWING a rule that reads each of the seven fields' stored values. The evaluator binds all seven fields on `resource` and `request.resource` and agrees on all 9 cases.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["the evaluator denies reads and writes production allows on these fields"],
  oracleObservations: ["rules-storage-h1-resource-unmodeled-fields"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
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
