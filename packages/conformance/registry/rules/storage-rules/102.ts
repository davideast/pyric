import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["recursiveWildcard"],
  behavior: "Multi-segment wildcard `{allPaths=**}` matches zero-or-more remaining segments",
  status: "conforms",
  evidence: "`oracle:rules-storage-v2-recursive-wildcard-zero-or-more` (6 cases: zero, one, and multiple remaining segments under `rules_version = '2'`), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules-evaluator.test.ts`",
  oracleObservations: ["rules-storage-v2-recursive-wildcard-zero-or-more"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules-evaluator.test.ts"],
});
