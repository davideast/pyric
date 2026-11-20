import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "The sandbox mirror validates Firebase's `mockUserToken` option shape (`string`, `{ sub }`, `{ user_id }` accepted; object missing `sub`/`user_id` throws synchronously) across all three planes",
  evidence: "`observations/firestore/firestore-connect-emulator-options.json` replayed across in-page, SharedWorker, and Node-hosted planes (`firestore-emulator-and-anon-listener.test.ts`)",
  automation: "oracle-backed",
  oracleObservations: ["firestore-connect-emulator-options"],
  conformanceTests: [
    "packages/pyric/test/firestore/oracle-captures/firestore-emulator-and-anon-listener.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-emulator-and-anon-listener.test.ts",
  ],
});
