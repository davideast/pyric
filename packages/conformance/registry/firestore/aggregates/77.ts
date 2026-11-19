import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["count","sum","average"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`count()` / `sum(field)` / `average(field)` compose under one spec across dotted nested string paths and `FieldPath` instances, exposing `AggregateField` `type: 'AggregateField'` and `aggregateType` (`'count' | 'sum' | 'avg'`)",
  evidence: "`unit:sandbox-target.test.ts`, `unit:upstream-write-aggregate-probes.test.ts`, `oracle:firestore-aggregate-compose-dotted-and-fieldpath`",
  oracleObservations: ["firestore-aggregate-compose-dotted-and-fieldpath"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/upstream-write-aggregate-probes.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-aggregates.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-aggregates.test.ts"],
});
