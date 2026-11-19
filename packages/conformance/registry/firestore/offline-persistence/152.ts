import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["terminate"],
  api: "terminate",
  behavior: "Terminates only the selected Firestore service instance: held refs reject with `failed-precondition`, owned listeners stop, and sibling Firestore or Auth services remain usable",
  status: "conforms",
  evidence: "Real Chromium: `packages/conformance/observations/firestore/firestore-browser-lifecycle.json` records `failed-precondition` on the terminated instance while Auth and a sibling Firestore instance continue; replayed across in-page sandbox, SharedWorker, Node-hosted WebSocket, and served surface planes by `oracle-conformance.test.ts`, `terminate.test.ts`, and `firestore-browser-lifecycle.test.ts`.",
  risk: ["error-code","listener"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `failed-precondition`","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-browser-lifecycle"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/terminate.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-browser-lifecycle.test.ts"],
  conformanceChecks: [{
    finding: "FS-152",
    observation: "firestore-browser-lifecycle",
    expect: {
      readAfterTerminateThrew: true,
      readAfterTerminateCode: "failed-precondition",
      authAfterTerminateThrew: false,
      siblingAfterTerminateThrew: false,
      siblingAfterTerminateValue: "sibling",
    },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Termination invalidates only the selected Firestore target while sibling services remain usable.",
  }],
});
