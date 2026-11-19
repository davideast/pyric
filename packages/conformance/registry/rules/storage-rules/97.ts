import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["parseStorageRules"],
  behavior: "`parseStorageRules` rejects unterminated string literals with `SyntaxError`",
  status: "conforms",
  evidence: "`oracle:rules-storage-unterminated-string-literal` (`COMPILE_ERROR` with `ERROR@6:5 Missing a closing '`), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules.test.ts`",
  oracleObservations: ["rules-storage-unterminated-string-literal"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules.test.ts"],
});
