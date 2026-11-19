import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getAuth"],
  api: "getAuth(app) in a registered server process",
  behavior: "Under a remote register activation on the Node host, `firebase/auth` in a server process signs in to the host: the session belongs to that process, the user is visible to `firebase-admin`, and its identity applies to the process's RTDB, Firestore and Storage calls. The session lasts as long as the process. When the host is not the Node host, every call fails with `failed-precondition` and a message naming the Node host (`pyric sandbox --hosted` or `pyric({ hosted: true })`); when no host is found, with the discovery error `pyric-admin` gets. No call falls back to an in-process sandbox.",
  statusNote: "one configuration per runtime; the session is not persisted across processes",
  evidence: "App scenario `test/apps/client-sdk-under-register` runs the client SDKs under `node --import @pyric/cli/register` against a hosted Vite dev server, reads back with `firebase-admin` and a page, and asserts a user the process created that firebase-admin finds, and rules that allow that user's own path and deny another's. On main (942cb175) it failed: the calls ran against a private in-process sandbox, so an upload returned a `data:` URL and firebase-admin read nothing they wrote. `packages/cli/test/register/node-origin.test.ts` runs the served surfaces under a Node origin whose host is not the Node host, or cannot be found, and asserts every call fails, `useWorker` stays true, the served app entry's placeholder sandbox stays empty, and a `pyric/*` mirror resolved from the app refuses. `mapping.test.ts` pins the mapping per activation value..",
  conformanceTests: ["test/apps/client-sdk-under-register/scenario.ts", "packages/cli/test/register/node-origin.test.ts", "packages/cli/test/register/mapping.test.ts", "packages/cli/test/register/register-child.test.ts"],
});
