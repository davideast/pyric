import { cddLifecycleTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["set", "get", "onDisconnect", "runTransaction"],
  api: "Calls in flight at a hosted connection drop (web hosted client)",
  behavior: "When the web hosted client's socket drops, an RTDB write (`set`, `update`, `remove`, `setPriority`, `setWithPriority`, `push`) or `get` the socket had taken is sent again after the client re-attaches, ahead of any call issued later, under a new request id, and resolves on the new reply with no deadline; a late reply to the copy the dropped socket took is ignored. A write sent again may apply twice. An `onDisconnect` registration or `cancel()` the socket had taken never settles and is not sent again. A transaction commit the socket had taken rejects with `Error('disconnect')`, which has no code, and is not retried.",
  statusNote: "web hosted client; the Kotlin, Swift and Flutter clients still fail these with `unavailable` (#1048)",
  evidence: "Oracle `rtdb-modular-socket-drop-in-flight-fates` (captured against `firebase/database` 12.19.0 over the RTDB v5 WebSocket wire protocol) records `restoreState_` resend ordering, preserved 20-character `push` keys, fresh request ids with stale old-id replies ignored, non-resent unsettled in-flight `onDisconnect` calls, and immediate codeless `Error('disconnect')` transaction rejection, replayed against the web hosted client in `packages/cli/test/serve/worker/oracle-captures/rtdb-socket-drop-in-flight-fates.test.ts` and pinned in-page by `packages/pyric/test/database/cdd/capture-socket-drop-in-flight-fates.test.ts`. `packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts`, `hosted-resume-late-reply.test.ts`, `hosted-delivery-contract.test.ts`, app scenario `test/apps/rtdb-write-in-flight-at-drop` (#1088), and CDD assertion `rtdb-modular#HD1` cover the hosted bridge session and Chromium socket-drop paths.",
  notes: "A call issued while the client is not attached, and never sent, is held for at most 10 seconds and then fails with `unavailable` saying it was not sent, where the SDK queues it with no deadline. ADR-0019 decision 7 keeps that deadline for reads and writes alike; only calls in flight at the drop follow the SDK. In the SDK's `restoreState_`, `outstandingPuts_` and queued `onDisconnect`s flush before `outstandingGets_`, whereas Pyric flushes all re-held in-flight `resend` calls (`writes` and `get`, in issue order) ahead of calls issued while disconnected.",
  conformanceTests: [
    "packages/cli/test/serve/worker/oracle-captures/rtdb-socket-drop-in-flight-fates.test.ts", "packages/pyric/test/database/cdd/capture-socket-drop-in-flight-fates.test.ts",
    "packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts", "packages/cli/test/serve/worker/hosted-delivery-contract.test.ts",
    "packages/cli/test/serve/worker/hosted-resume-late-reply.test.ts", "test/apps/rtdb-write-in-flight-at-drop/scenario.ts", ...cddLifecycleTests,
  ],
});
