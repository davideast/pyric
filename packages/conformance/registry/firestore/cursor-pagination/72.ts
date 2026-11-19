import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["endAt"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-query-cursors-endat-snap-and-pagination"],
  behavior: "`endAt(snapshot)` overload",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-query-cursors-endat-snap-and-pagination` (`endAtSnapshot.ascIds: ['item-1', 'item-2', 'item-3']`, `descIds: ['item-5', 'item-4', 'item-3']`)",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
