import { row } from './section.ts';

export default row({
  order: 10,
  section: "Server-rendered modules under vite dev",
  featureKeys: ["getFirestore"],
  api: "getFirestore(app) in a server-rendered module under vite dev",
  behavior: "On a hosted dev server, `firebase/firestore` in a server-rendered module reads and writes the host's documents under its rules as the SSR session's user: a write the rules deny for that user fails with `permission-denied`. `ssrLoadModule`, the environment runner and every `ssr.noExternal` setting share one app and one session. On a SharedWorker dev server every call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`. No call reaches production or an in-process sandbox.",
  statusNote: "one SSR session per dev server process, as one Node server process has one auth state; per-request identity (`initializeServerApp`) is unsupported",
  evidence: "App scenario `test/apps/vite-ssr-client-sdk` writes and reads the SSR user's own document, is denied another user's, reads the writes back with `firebase-admin` in SSR and in a process on the host, with each externalization setting, and refuses on a SharedWorker dev server. On main (ba2c0bf0a) the scenario failed: SSR sign-in rejected with `auth/network-request-failed` from the network guard, and the RTDB, Firestore and Storage writes did not settle, because the imports loaded the real SDK. `vite-module-swap.test.ts` pins the routing per specifier, AI mode and environment (Vite 5's `ssr` option, a runnable environment, a non-runnable one), `vite-ssr-activation.test.ts` the host, the restart hand-over and the SharedWorker refusal, and `vite-plugin-firestore.test.ts` runs Vite with `firebase` installed, so it takes the externalized path.",
  conformanceTests: ["test/apps/vite-ssr-client-sdk/scenario.ts", "packages/cli/test/serve/vite-module-swap.test.ts", "packages/cli/test/serve/vite-ssr-activation.test.ts", "packages/cli/test/serve/vite-plugin-firestore.test.ts"],
});
