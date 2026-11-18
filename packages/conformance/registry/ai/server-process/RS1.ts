import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getAI"],
  api: "getAI(app) in a registered server process",
  behavior: "Under a remote register activation, `getAI(app)` in a server process fails with `failed-precondition` and a message that names the client services that do reach the Node host: `firebase/ai` has no path to the host, and no in-process sandbox stands in for it. Production AI pass-through (`PYRIC_AI=production`) loads the real `firebase/ai` and is unaffected.",
  statusNote: "refused in a server process; production runs it in Node",
  evidence: "App scenario `test/apps/client-sdk-under-register` calls it under `node --import @pyric/cli/register` against a hosted Vite dev server and asserts the refusal; on main (942cb175) it returned a handle on a private in-process sandbox. `mapping.test.ts` pins that the subpath keeps its mirror under a remote activation, and `node-origin.test.ts` that a mirror resolved from such an app refuses.",
  conformanceTests: [
    "test/apps/client-sdk-under-register/scenario.ts",
    "packages/cli/test/register/mapping.test.ts",
    "packages/cli/test/register/node-origin.test.ts",
  ],
});
