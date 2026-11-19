import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getFirestore"],
  api: "getFirestore(app) in a registered server process",
  behavior: "Under a remote register activation on the Node host, `firebase/firestore` in a server process reads and writes the host's documents under its rules as the process's signed-in user. An open listener keeps the process up; a finished write releases it at once. A CommonJS `require('firebase/firestore')` resolves the same client. An app whose options differ from the host's gets each call rejected with `app/multiple-configs-not-supported`, and nothing throws past the call. When the host is not the Node host, every call fails with `failed-precondition` and a message naming the Node host (`pyric sandbox --hosted` or `pyric({ hosted: true })`); when no host is found, with the discovery error `pyric-admin` gets. No call falls back to an in-process sandbox.",
  statusNote: "a finished write releases the process at once, where production holds it until the write stream's 60 s idle timeout; one configuration per runtime",
  evidence: "App scenario `test/apps/client-sdk-under-register` runs the client SDKs under `node --import @pyric/cli/register` against a hosted Vite dev server, reads back with `firebase-admin` and a page, and asserts a write the page and firebase-admin read, a CommonJS require, an app with other options rejected per call, and that a listener holds the process while a finished write does not. On main (942cb175) it failed: the calls ran against a private in-process sandbox, so an upload returned a `data:` URL and firebase-admin read nothing they wrote. `packages/cli/test/register/node-origin.test.ts` runs the served surfaces under a Node origin whose host is not the Node host, or cannot be found, and asserts every call fails, `useWorker` stays true, the served app entry's placeholder sandbox stays empty, and a `pyric/*` mirror resolved from the app refuses. `mapping.test.ts` pins the mapping per activation value..",
  conformanceTests: [
    "test/apps/client-sdk-under-register/scenario.ts",
    "packages/cli/test/register/node-origin.test.ts",
    "packages/cli/test/register/mapping.test.ts",
    "packages/cli/test/register/register-child.test.ts",
  ],
});
