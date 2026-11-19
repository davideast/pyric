import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["enableIndexedDbPersistence"],
  api: "enableIndexedDbPersistence",
  behavior: "Resolves before Firestore starts and rejects with `failed-precondition` after any operation has started the service",
  status: "diverged-documented",
  statusNote: "an accepted no-op on the served planes (FP-9)",
  conformanceDisposition: "pending-fix",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json`; replayed through the public modular API by `oracle-conformance.test.ts` and focused lifecycle coverage. Served planes: an accepted no-op that resolves after first use (FP-9).",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `failed-precondition`"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/persistence-network.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-served-surface.test.ts"],
  conformanceChecks: [{
    finding: "FS-140",
    observation: "firestore-browser-lifecycle",
    expect: { persistenceAfterUseThrew: true, persistenceAfterUseCode: "failed-precondition" },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Persistence initialization is accepted before use and rejected after service startup with production's error code.",
  }],
});
