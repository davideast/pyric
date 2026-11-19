import { row } from './section.ts';

export default row({
  order: 20,
  section: "Server-rendered modules under vite dev",
  featureKeys: ["getDatabase"],
  api: "firebase-admin/database in a server-rendered module under vite dev",
  behavior: "On a hosted dev server, `firebase-admin` in a server-rendered module resolves to `pyric-admin` bound to the dev server's host, as a `firebase-admin` process on the host is: a bare `initializeApp()` connects to it, reads bypass the rules, and the writes of browsers and SSR sessions are visible. On a SharedWorker dev server its first call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`, without dialing.",
  statusNote: "admin reads and writes bypass the rules, as firebase-admin's do",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-admin-writes-sentinels-and-validation", "rtdb-rules-cascade-bindings-and-auth-context"],
  evidence: "Oracles `rtdb-modular-admin-writes-sentinels-and-validation` and `rtdb-rules-cascade-bindings-and-auth-context` are replayed through bare `initializeApp()` under `attachViteSsrActivation` and `server.ssrLoadModule` in `rtdb-server-process-and-vite-ssr.test.ts`, checking admin writes, sentinels, synchronous validation, rule bypass reading SSR and client writes, and SharedWorker `failed-precondition` refusal naming `pyric({ hosted: true })`. App scenario `test/apps/vite-ssr-client-sdk`, `ambient-init.test.ts`, and CDD assertion `rtdb-modular#RS3` pin the end-to-end and unit paths.",
  conformanceTests: ["packages/cli/test/serve/worker/oracle-captures/rtdb-server-process-and-vite-ssr.test.ts", "test/apps/vite-ssr-client-sdk/scenario.ts", "packages/pyric-admin/test/app/ambient-init.test.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
});
