import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["evaluateStorageRules","request.auth"],
  behavior: "`evaluateStorageRules` denies anonymous reads when the rule requires `request.auth != null`",
  status: "conforms",
  evidence: "`oracle:rules-storage-auth-non-null-read-guard` (anonymous `get` with explicit null auth and anonymous `list` with omitted auth both DENY), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules-evaluator.test.ts`",
  oracleObservations: ["rules-storage-auth-non-null-read-guard"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules-evaluator.test.ts"],
});
