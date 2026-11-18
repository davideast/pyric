import { row } from './section.ts';

export default row({
  order: 20,
  section: "Server-rendered modules under vite dev",
  featureKeys: ["getAI"],
  api: "getAI(app) in a server-rendered module under vite dev",
  behavior: "Under `vite dev`, `getAI(app)` in a server-rendered module fails with `failed-precondition` in the default sandbox AI mode, naming the client services that reach the host: `firebase/ai` has no path to the dev server's host from server code. In production AI mode the real `firebase/ai` loads and the network guard permits Firebase AI Logic. A SharedWorker dev server refuses it the same way.",
  statusNote: "refused in server-rendered modules under vite dev; production runs it in the server's runtime",
  evidence: "App scenario `test/apps/vite-ssr-client-sdk` calls it in SSR on a hosted dev server and asserts the refusal; a second dev server in production AI mode lets the real SDK reach only `firebasevertexai.googleapis.com`, which a stand-in beneath the guard refuses. On main (ba2c0bf0a) it was the real SDK. `vite-module-swap.test.ts` pins the routing.",
  conformanceTests: ["test/apps/vite-ssr-client-sdk/scenario.ts", "packages/cli/test/serve/vite-module-swap.test.ts"],
});
