import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getFirestore"],
  api: "getFirestore(app, databaseId) (served mode)",
  behavior: "The served `firebase/firestore` entry ignores the database id: the worker path returns the app's one handle and the in-page fallback delegates to the sandbox `getFirestore(app)`. The worker protocol carries no database id.",
  statusNote: "every database id resolves to (default)",
  evidence: "`packages/cli/test/serve/worker/composite-filters-served-entry.test.ts` imports the served entry over a worker host, asserts `getFirestore(app, 'reports')` returns the app's handle, and reads the `(default)` documents through it.",
  conformanceTests: ["packages/cli/test/serve/worker/composite-filters-served-entry.test.ts"],
});
