import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["request.time","timestamp.date","timestamp.value"],
  behavior: "`request.time` compared against `timestamp.date(y,m,d)` and `timestamp.value(ms)` constructors",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-10: production capture proves the evaluator supports `request.time` comparisons against both timestamp constructors. `oracle:rules-storage-request-time-timestamp` matches production verdict-for-verdict on all 4 cases (deadline-before/after via `timestamp.date()`, epoch-bound before/after via `timestamp.value()`).",
  oracleObservations: ["rules-storage-request-time-timestamp"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
