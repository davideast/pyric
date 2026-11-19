import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["enableIndexedDbPersistence"],
  api: "enableIndexedDbPersistence",
  behavior: "Resolves before Firestore starts and rejects with `failed-precondition` after any operation has started the service",
  status: "conforms",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json`; replayed across in-page sandbox, SharedWorker, Node-hosted WebSocket, and served surface planes by `oracle-conformance.test.ts` and `firestore-browser-lifecycle.test.ts`.",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `failed-precondition`"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/persistence-network.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-served-surface.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-browser-lifecycle.test.ts"],
  conformanceChecks: [{
    finding: "FS-140",
    observation: "firestore-browser-lifecycle",
    expect: { persistenceAfterUseThrew: true, persistenceAfterUseCode: "failed-precondition" },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Persistence initialization is accepted before use and rejected after service startup with production's error code.",
  }],
});
