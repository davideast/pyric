import { row } from './section.ts';

export default row({
  order: 90,
  automation: "oracle-backed",
  oracleObservations: ["firestore-onsnapshot-filtered-timestamp-and-refs"],
  behavior: "Snapshot's `.ref` / `.docs[i].ref` are tagged so consumer code can pass them to follow-up ops",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-onsnapshot-filtered-timestamp-and-refs` (`docRefEqualsOriginal: true`, `queryDocRefEqualsDocC: true`, `updatedScoreViaQueryDocRef: 60`)",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
