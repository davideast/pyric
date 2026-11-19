import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["enableLogging"],
  behavior: "`enableLogging(logger?, persistent?)` wires custom `(message: string) => void` callbacks and boolean `console.log` toggles across client RTDB operations, silences emission on `enableLogging(false)`, and throws synchronously when `persistent` is `true` with a custom callback",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "Oracle `rtdb-modular-client-emulator-and-logging` replayed across in-process sandbox, served SharedWorker, and served Node host (`oracle-conformance-emulator-and-logging.test.ts`, `rtdb-client-emulator-and-logging.test.ts`).",
  oracleObservations: ["rtdb-modular-client-emulator-and-logging"],
  conformanceTests: ["packages/pyric/test/database/modular/fruit-aliases.test.ts","packages/pyric/test/database/modular/oracle-conformance-emulator-and-logging.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-client-emulator-and-logging.test.ts"],
  aliases: ["rtdb#173"],
});
