import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["waitForPendingWrites"],
  api: "waitForPendingWrites",
  behavior: "Waits for outstanding offline write acknowledgements and resolves when network re-enable drains them",
  status: "conforms",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json`; replayed through the public modular API by `oracle-conformance.test.ts` and focused pending-write coverage.",
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/persistence-network.test.ts"],
  conformanceChecks: [{
    finding: "FS-144",
    observation: "firestore-browser-lifecycle",
    expect: { offlineWaitForPendingWritesPending: true, reconnectedServerValue: "offline" },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "waitForPendingWrites remains pending offline and completes after reconnect drains acknowledgements.",
  }],
});
