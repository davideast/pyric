import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "Listener registered while signed out keeps firing across Auth sign-in and subsequent session transitions without duplicate reauthorization snapshots",
  evidence: "`observations/firestore/firestore-anonymous-listener-auth-transition.json` replayed across in-page, SharedWorker, and Node-hosted planes (`firestore-emulator-and-anon-listener.test.ts`)",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-anonymous-listener-auth-transition"],
  conformanceTests: [
    "packages/pyric/test/firestore/sandbox-live-identity.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-emulator-and-anon-listener.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-emulator-and-anon-listener.test.ts",
  ],
});
