import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getAuth"],
  api: "getAuth(app) in a server-rendered module under vite dev",
  behavior: "On a hosted dev server, `firebase/auth` in a server-rendered module signs in to the host. The session belongs to the dev server process: every SSR request, both of Vite's SSR loaders and a module reloaded after an edit see the same `currentUser`, and its identity applies to the SSR RTDB, Firestore and Storage calls. Browser sessions are separate. On a SharedWorker dev server every call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`. No call reaches production or an in-process sandbox.",
  statusNote: "one SSR session per dev server process, as one Node server process has one auth state; per-request identity (`initializeServerApp`) is unsupported",
  evidence: "App scenario `test/apps/vite-ssr-client-sdk` signs in through `ssrLoadModule`, then finds the same user through the environment runner, and checks that the rules allow that user's paths and deny another's. On main (ba2c0bf0a) the scenario failed: SSR sign-in rejected with `auth/network-request-failed` from the network guard, and the RTDB, Firestore and Storage writes did not settle, because the imports loaded the real SDK. `vite-module-swap.test.ts` pins the routing per specifier, AI mode and environment (Vite 5's `ssr` option, a runnable environment, a non-runnable one), `vite-ssr-activation.test.ts` the host, the restart hand-over and the SharedWorker refusal, and `vite-plugin-firestore.test.ts` runs Vite with `firebase` installed, so it takes the externalized path.",
  conformanceTests: ["test/apps/vite-ssr-client-sdk/scenario.ts", "packages/cli/test/serve/vite-module-swap.test.ts", "packages/cli/test/serve/vite-ssr-activation.test.ts", "packages/cli/test/serve/vite-plugin-firestore.test.ts"],
});
