import { row } from './section.ts';

export default row({
  order: 410,
  featureKeys: ["connectDatabaseEmulator"],
  behavior: "`connectDatabaseEmulator(db, host, port)` rebinds the database handle's reference URL origin to `http://<host>:<port>/` before the instance starts (including pre-start overwrite, `[::1]` IPv6 hosts, and custom-host `refFromURL` resolution), allows idempotent identical post-start repeats, and throws `FIREBASE FATAL ERROR` on post-start changes or deleted databases while routing data locally",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-client-emulator-and-logging` replayed across in-process sandbox (`oracle-conformance-emulator-and-logging.test.ts`), served SharedWorker, and served Node host (`rtdb-client-emulator-and-logging.test.ts`).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-client-emulator-and-logging"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts","packages/pyric/test/database/modular/oracle-conformance-emulator-and-logging.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-client-emulator-and-logging.test.ts"],
  rowNumber: 32,
});
