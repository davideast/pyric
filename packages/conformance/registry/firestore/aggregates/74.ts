import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getCountFromServer","count"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`getCountFromServer(query)` returns an `AggregateQuerySnapshot` (`type: 'AggregateQuerySnapshot'`) whose `.data()` yields `{ count: N }` across empty, populated, and limit-capped queries, and `count()` exposes `{ type: 'AggregateField', aggregateType: 'count' }`",
  evidence: "`unit:sandbox-target.test.ts`; collectionGroup: `unit:upstream-write-aggregate-probes.test.ts`; `oracle:firestore-getcountfromserver-data-shape`",
  oracleObservations: ["firestore-getcountfromserver-data-shape"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/upstream-write-aggregate-probes.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-aggregates.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-aggregates.test.ts"],
});
