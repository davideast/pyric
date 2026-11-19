import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["enableNetwork","disableNetwork"],
  api: "enableNetwork / disableNetwork",
  behavior: "Disabling network exposes local mutations with cache/pending-write metadata while holding write acknowledgement until network is re-enabled",
  status: "diverged-documented",
  statusNote: "an accepted no-op on the served planes (FP-9)",
  conformanceDisposition: "pending-fix",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json`; replayed through the public modular API by `oracle-conformance.test.ts` and focused network coverage. Served planes: accepted no-ops, so an offline write commits at once (FP-9).",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/persistence-network.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-served-surface.test.ts"],
  conformanceChecks: [{
    finding: "FS-143",
    observation: "firestore-browser-lifecycle",
    expect: { offlineWritePending: true, offlineLocalValue: "offline", offlineSnapshotFromCache: true, offlineSnapshotHasPendingWrites: true, reconnectedServerValue: "offline" },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Offline writes are locally visible with pending metadata and acknowledge only after reconnect.",
  }],
});
