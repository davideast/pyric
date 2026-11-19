import { row } from './section.ts';

export default row({
  order: 10,
  section: "Server-rendered modules under vite dev",
  featureKeys: ["getDatabase"],
  api: "getDatabase(app) in a server-rendered module under vite dev",
  behavior: "On a hosted dev server, `firebase/database` in a server-rendered module reads and writes the host's data under its rules as the SSR session's user: a write the rules deny for that user fails with `PERMISSION_DENIED`. `ssrLoadModule`, the environment runner and every `ssr.noExternal` setting share one app and one session. Closing the dev server lets the process go, so a process that created the server through Vite's API ends on its own, though RTDB would otherwise hold it until `goOffline()`. On a SharedWorker dev server every call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`. No call reaches production or an in-process sandbox.",
  statusNote: "one SSR session per dev server process, as one Node server process has one auth state; per-request identity (`initializeServerApp`) is unsupported",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-cascade-bindings-and-auth-context"],
  evidence: "Oracle `rtdb-rules-cascade-bindings-and-auth-context` is replayed across `server.ssrLoadModule` (`ssr.noExternal: ['firebase']`) on a hosted Vite dev server in `rtdb-server-process-and-vite-ssr.test.ts`, verifying `$userId` and `auth` rules verdicts, shared SSR app/session identity across module loads, clean process exit on `server.close()`, and SharedWorker `failed-precondition` refusal naming `pyric({ hosted: true })`. App scenario `test/apps/vite-ssr-client-sdk`, `vite-module-swap.test.ts`, `vite-ssr-activation.test.ts`, `vite-plugin-firestore.test.ts`, `node-realm.test.ts`, and CDD assertion `rtdb-modular#RS2` pin the end-to-end and unit paths.",
  conformanceTests: ["packages/cli/test/serve/worker/oracle-captures/rtdb-server-process-and-vite-ssr.test.ts", "test/apps/vite-ssr-client-sdk/scenario.ts", "packages/cli/test/serve/vite-module-swap.test.ts", "packages/cli/test/serve/vite-ssr-activation.test.ts", "packages/cli/test/serve/vite-plugin-firestore.test.ts", "packages/cli/test/register/node-realm.test.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
});
