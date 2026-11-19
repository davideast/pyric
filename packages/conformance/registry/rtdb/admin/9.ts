import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['Database.useEmulator'],
  api: 'db.useEmulator(host, port)',
  behavior:
  'Rebinds reference and `refFromURL` URLs to `http://${host}:${port}/...` when called before the `Database` instance starts (allowing pre-start `(host, port)` overwrite and custom-host `refFromURL` resolution while routing sandbox and remote data operations locally), treats repeat `useEmulator` calls with the identical `(host, port)` and options after start as an idempotent no-op, and throws `FIREBASE FATAL ERROR` on post-start initialization or alteration, Admin `mockUserToken` options, or deleted databases.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['rtdb-modular-admin-use-emulator-validation'],
  conformanceTests: [
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
    'packages/pyric-admin/test/database/capture-admin-use-emulator.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-use-emulator.test.ts',
  ],
  evidence:
  'Production capture `rtdb-modular-admin-use-emulator-validation` records pre-start `http://${host}:${port}` URL rebinding and overwrite, `refFromURL` custom-host acceptance, host/port boundary interpolation, idempotent post-start repeat calls, and fatal errors on post-start alteration, `mockUserToken`, and deleted databases; replayed verbatim across in-process, remote SharedWorker, served SharedWorker, and Node host planes.',
  risk: ['error-code', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts pre-start URL rebinding, post-start fatal guards, and 4-plane admin data routing'],
});
