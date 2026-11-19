import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["enableMultiTabIndexedDbPersistence"],
  api: "enableMultiTabIndexedDbPersistence",
  behavior: "Enables multi-client shared persistence before first use, permits two clients to opt in, and rejects initialization after a client has started with `failed-precondition`",
  status: "conforms",
  evidence: "Real Chromium: `firestore-browser-lifecycle.json` exercises fresh, after-use, and two-client initialization; replayed through public APIs by `oracle-conformance.test.ts` and focused persistence tests.",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `failed-precondition`"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/persistence-network.test.ts"],
  conformanceChecks: [{
    finding: "FS-141",
    observation: "firestore-browser-lifecycle",
    expect: { multiTabEnableThrew: false, multiTabEnableCode: null, multiTabAfterUseThrew: true, multiTabAfterUseCode: "failed-precondition", multiTabTwoClientsThrew: false, multiTabTwoClientsCode: null },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Fresh and concurrent multi-client initialization succeeds while late initialization uses production's error code.",
  }],
});
