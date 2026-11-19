import { row } from './section.ts';

export default row({
  order: 30,
  rowNumber: 81,
  automation: "oracle-backed",
  oracleObservations: ["firestore-onsnapshot-filtered-timestamp-and-refs"],
  behavior: "**Filtered listeners honor `where` / `orderBy` / `limit` (FS-B2)** -- `onSnapshot(query(coll, where(...), orderBy(...), limit(...)), cb)` delivers the same membership as `getDocs(sameQuery)`: non-matching docs are excluded on the initial fire and on writes; ordering + limit are applied. Pre-FS-B2 the `SnapshotTarget` dropped all constraints and delivered the whole collection.",
  evidence: "`unit:onsnapshot-query-constraints.test.ts`, `oracle:firestore-onsnapshot-filtered-timestamp-and-refs` (`initialMatchesGetDocs: true`, `finalMatchesGetDocs: true`)",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  conformanceTests: ["packages/pyric/test/firestore/onsnapshot-query-constraints.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
