import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getStorage"],
  api: "getStorage(app) in a registered server process",
  behavior: "Under a remote register activation on the Node host, `firebase/storage` in a server process uploads and reads the host's objects under its rules, over the host's byte route. An upload issued before the process's connection has attached waits for the attachment, keeps its place in the call order, and never sends its bytes as frames to a host that takes them only over the route; it fails as a held call does if the connection is not restored within 10 seconds. A finished upload does not keep the process up. When the host is not the Node host, every call fails with `failed-precondition` and a message naming the Node host (`pyric sandbox --hosted` or `pyric({ hosted: true })`); when no host is found, with the discovery error `pyric-admin` gets. No call falls back to an in-process sandbox.",
  statusNote: "a resumable upload issued before the connection attaches reports its progress in one step on a byte-route host",
  evidence: "App scenario `test/apps/client-sdk-under-register` runs the client SDKs under `node --import @pyric/cli/register` against a hosted Vite dev server, reads back with `firebase-admin` and a page, and asserts an upload issued as the process's first call that firebase-admin downloads, its HTTP download URL, and that a finished upload does not hold the process. `storage-byte-route-settled.test.ts` pins the wait, the call order and the deadline. On main (942cb175) it failed: the calls ran against a private in-process sandbox, so an upload returned a `data:` URL and firebase-admin read nothing they wrote. `packages/cli/test/register/node-origin.test.ts` runs the served surfaces under a Node origin whose host is not the Node host, or cannot be found, and asserts every call fails, `useWorker` stays true, the served app entry's placeholder sandbox stays empty, and a `pyric/*` mirror resolved from the app refuses. `mapping.test.ts` pins the mapping per activation value..",
  conformanceTests: [
    "test/apps/client-sdk-under-register/scenario.ts",
    "packages/cli/test/register/node-origin.test.ts",
    "packages/cli/test/register/mapping.test.ts",
    "packages/cli/test/register/register-child.test.ts",
    "packages/cli/test/serve/worker/storage-byte-route-settled.test.ts",
  ],
});
