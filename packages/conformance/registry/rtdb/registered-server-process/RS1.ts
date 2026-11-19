import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getDatabase"],
  api: "getDatabase(app) in a registered server process",
  behavior: "Under a remote register activation on the Node host, `firebase/database` in a server process reads and writes the host's data under its rules as the process's signed-in user: a write the rules deny for that user fails with `PERMISSION_DENIED`, `.info/connected` follows the process's connection, and an `onDisconnect` write runs when that connection ends. From its first RTDB call on an instance the process stays up until `goOffline()` on that instance or `deleteApp()`, as `@firebase/database` keeps a Node process up. When the host is not the Node host, every call fails with `failed-precondition` and a message naming the Node host (`pyric sandbox --hosted` or `pyric({ hosted: true })`); when no host is found, with the discovery error `pyric-admin` gets. No call falls back to an in-process sandbox.",
  statusNote: "the app must use the same Firebase options as the host's other clients (one configuration per runtime)",
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-cascade-bindings-and-auth-context", "rtdb-modular-ondisconnect-clean-set", "rtdb-modular-ondisconnect-abrupt-exit"],
  evidence: "Oracles `rtdb-rules-cascade-bindings-and-auth-context`, `rtdb-modular-ondisconnect-clean-set`, and `rtdb-modular-ondisconnect-abrupt-exit` are replayed through a `node --import @pyric/cli/register` child process against `createHostedRuntime` in `rtdb-server-process-and-vite-ssr.test.ts`, checking `$userId` and `auth` rules verdicts, `.info/connected`, clean `goOffline()` release and one-shot `onDisconnect`, forced `SIGKILL` `onDisconnect` delivery, and off-host `failed-precondition` refusal. App scenario `test/apps/client-sdk-under-register`, `node-realm.test.ts`, `node-origin.test.ts`, `mapping.test.ts`, `register-child.test.ts`, and CDD assertion `rtdb-modular#RS1` pin the end-to-end and unit paths.",
  conformanceTests: ["packages/cli/test/serve/worker/oracle-captures/rtdb-server-process-and-vite-ssr.test.ts", "test/apps/client-sdk-under-register/scenario.ts", "packages/cli/test/register/node-origin.test.ts", "packages/cli/test/register/mapping.test.ts", "packages/cli/test/register/register-child.test.ts", "packages/cli/test/register/node-realm.test.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
});
