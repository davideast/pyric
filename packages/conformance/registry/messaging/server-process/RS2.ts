import { row } from './section.ts';

export default row({
  order: 20,
  section: "Server-rendered modules under vite dev",
  featureKeys: ["Messaging"],
  api: "getMessaging(app) in a server-rendered module under vite dev",
  behavior: "Under `vite dev`, `getMessaging(app)` in a server-rendered module fails with `failed-precondition`, naming the client services that reach the host: `firebase/messaging` has no path to the dev server's host from server code, and the real SDK does not load.",
  statusNote: "refused in server-rendered modules under vite dev; production runs it in the server's runtime",
  evidence: "App scenario `test/apps/vite-ssr-client-sdk` calls it in SSR on a hosted dev server and asserts the refusal. On main (ba2c0bf0a) it was the real SDK. `vite-module-swap.test.ts` pins the routing.",
  conformanceTests: ["test/apps/vite-ssr-client-sdk/scenario.ts", "packages/cli/test/serve/vite-module-swap.test.ts", "packages/pyric/test/messaging/oracle-conformance.test.ts"],
});
