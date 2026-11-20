import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Production does not enter the mirror: inactive package resolution leaves Firebase's `connectFirestoreEmulator` implementation unchanged, and active handles enforce pre-start lifecycle parity across all three planes",
  evidence: "`observations/firestore/firestore-connect-emulator-options.json` replayed across in-page, SharedWorker, and Node-hosted planes (`firestore-emulator-and-anon-listener.test.ts`), plus `node-register:register-child.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-connect-emulator-options"],
  conformanceTests: [
    "packages/cli/test/register/register-child.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-emulator-and-anon-listener.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-emulator-and-anon-listener.test.ts",
  ],
});
