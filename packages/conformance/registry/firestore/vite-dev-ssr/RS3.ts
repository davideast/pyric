import { row } from './section.ts';

export default row({
  order: 20,
  section: "Server-rendered modules under vite dev",
  featureKeys: ["getFirestore"],
  api: "firebase-admin/firestore in a server-rendered module under vite dev",
  behavior: "On a hosted dev server, `firebase-admin/firestore` in a server-rendered module reads and writes the dev server host's documents as admin, past the rules, as a `firebase-admin` process on the host does. On a SharedWorker dev server its first call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`.",
  statusNote: "admin reads and writes bypass the rules, as firebase-admin's do",
  evidence: "App scenario `test/apps/vite-ssr-client-sdk` reads a document the rules let only the SSR user read with `firebase-admin` in SSR through both loaders and with each externalization setting. On main (ba2c0bf0a) `firebase-admin` in SSR was the real SDK. `ambient-init.test.ts` pins the ambient binding.",
  conformanceTests: ["test/apps/vite-ssr-client-sdk/scenario.ts", "packages/pyric-admin/test/app/ambient-init.test.ts"],
});
