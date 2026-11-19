import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["evaluateStorageRules","request.resource.size"],
  behavior: "`evaluateStorageRules` supports `request.resource.size < N` constraints (with arithmetic literals like `10 * 1024 * 1024`)",
  status: "conforms",
  evidence: "`oracle:rules-storage-request-resource-size-strict-less-than` (6 cases: 0, `N - 1`, exact `N`, `N + 1`, `update`, and `delete`), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules-evaluator.test.ts`",
  oracleObservations: ["rules-storage-request-resource-size-strict-less-than"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules-evaluator.test.ts"],
});
