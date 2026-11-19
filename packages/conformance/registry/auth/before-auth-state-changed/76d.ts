import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Served-worker path (SharedWorker-backed auth in `@pyric/cli`): the worker owns the shared user pool and commits transitions on its own side of the port, so a page-local `beforeAuthStateChanged` registration can't actually gate a worker-driven sign-in. Rather than silently accept a callback that could never run, registering THROWS immediately (`auth/operation-not-supported-in-this-environment`) — same defensive pattern as `signInWithCredential` over the worker.",
  status: "diverged-documented",
  evidence: "`packages/cli/src/serve/worker/client.ts` (`beforeAuthStateChanged` throws `makeUnsupported`)",
  risk: ["error-code"],
  riskScore: 3,
  riskReasons: ["asserts Firebase error code(s): `auth/operation-not-supported-in-this-environment`"],
  automation: "sandbox-only",
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe (there is no SharedWorker-backed auth in real Firebase)",
  notes: "In-page (non-worker) serve mode has full parity — this divergence is worker-mode only. Follow-up: thread registration through the worker RPC protocol so the gate can run host-side before the worker commits a transition.",
  rowNumber: 76,
});
