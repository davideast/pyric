import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getStorage"],
  api: "getStorage(app) in a server-rendered module under vite dev",
  behavior: "On a hosted dev server, `firebase/storage` in a server-rendered module uploads and reads the host's objects under its rules as the SSR session's user, over the host's byte route: an upload to another user's path fails with `storage/unauthorized`, and a download URL names the host's byte route. On a SharedWorker dev server every call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`. No call reaches production or an in-process sandbox.",
  statusNote: "one SSR session per dev server process, as one Node server process has one auth state; per-request identity (`initializeServerApp`) is unsupported",
  evidence: "App scenario `test/apps/vite-ssr-client-sdk` uploads to the SSR user's own path, reads its download URL, is denied another user's path, and downloads the object with `firebase-admin` in a process on the host. On main (ba2c0bf0a) the scenario failed: SSR sign-in rejected with `auth/network-request-failed` from the network guard, and the RTDB, Firestore and Storage writes did not settle, because the imports loaded the real SDK. `vite-module-swap.test.ts` pins the routing per specifier, AI mode and environment (Vite 5's `ssr` option, a runnable environment, a non-runnable one), `vite-ssr-activation.test.ts` the host, the restart hand-over and the SharedWorker refusal, and `vite-plugin-firestore.test.ts` runs Vite with `firebase` installed, so it takes the externalized path.",
  conformanceTests: ["test/apps/vite-ssr-client-sdk/scenario.ts", "packages/cli/test/serve/vite-module-swap.test.ts", "packages/cli/test/serve/vite-ssr-activation.test.ts", "packages/cli/test/serve/vite-plugin-firestore.test.ts"],
});
