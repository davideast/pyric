import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`connectDatabaseEmulator(db, host, port, { mockUserToken })` validates `EmulatorMockTokenOptions` (`sub` or `user_id` required, legacy `uid` rejected) and JWT strings, applying the mock user claims as the database handle's Security Rules auth identity across in-process and served sandboxes",
  status: "conforms",
  automation: "oracle-backed",
  exceptionReason: undefined,
  evidence: "Oracle `rtdb-modular-client-emulator-and-logging` + 3-plane `mockUserToken` Security Rules verification (`oracle-conformance-emulator-and-logging.test.ts`, `rtdb-client-emulator-and-logging.test.ts`).",
  oracleObservations: ["rtdb-modular-client-emulator-and-logging"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-emulator-and-logging.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-client-emulator-and-logging.test.ts"],
  aliases: ["rtdb#165"],
});
