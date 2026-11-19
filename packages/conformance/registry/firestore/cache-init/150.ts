import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["onSnapshotsInSync"],
  api: "onSnapshotsInSync",
  behavior: "Emits an initial in-sync signal, batches another signal after snapshot listener delivery, and stops after unsubscribe",
  status: "conforms",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json` records initial sync, write snapshot, then sync; replayed by `oracle-conformance.test.ts` and focused listener tests.",
  risk: ["listener","ordering"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts event ordering"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/tier1-cache-init-align.test.ts"],
  conformanceChecks: [{
    finding: "FS-150",
    observation: "firestore-browser-lifecycle",
    expect: { snapshotSyncOrdering: ["sync", "snapshot:written", "sync"] },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "The sync observer brackets write-driven snapshot delivery in the production-observed order.",
  }],
});
