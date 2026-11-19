import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["startAfter"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-query-cursors-endat-snap-and-pagination"],
  behavior: "`startAfter + limit` -- canonical pagination pattern",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-query-cursors-endat-snap-and-pagination` (paginates `[item-1, item-2]` -> `[item-3, item-4]` -> `[item-5]` -> `[]` with `page4Empty: true`)",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
