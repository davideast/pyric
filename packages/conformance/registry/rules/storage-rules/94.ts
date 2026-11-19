import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["parseStorageRules"],
  behavior: "`parseStorageRules(source)` returns an opaque handle",
  status: "conforms",
  evidence: "`oracle:rules-storage-parse-compound-storage-ruleset` (6 read/create/delete cases over nested `match`, `request.method` short-circuiting, arithmetic size bounds, and `contentType` equality), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules.test.ts`",
  oracleObservations: ["rules-storage-parse-compound-storage-ruleset"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules.test.ts"],
});
