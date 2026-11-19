import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["pathParameters"],
  behavior: "Path-parameter binding (`{sessionId}`) accessible inside the `if` expression",
  status: "conforms",
  evidence: "`oracle:rules-storage-path-param-binding-in-condition` (5 cases: single `{sessionId}` and nested `{userId}/sessions/{sessionId}` bindings in `allow` conditions), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules-evaluator.test.ts`",
  oracleObservations: ["rules-storage-path-param-binding-in-condition"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules-evaluator.test.ts"],
});
