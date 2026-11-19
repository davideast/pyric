import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: [],
  queryable: false,
  api: "pyric verify (RTDB onDisconnect registrations)",
  behavior: "An `onDisconnect().set()`, `.setWithPriority()`, `.update()` or `.remove()` registration by an application user is decided under the rules when it is registered, as production decides it, and recorded as an `onDisconnect.set` (with its priority for `.setWithPriority()`), `onDisconnect.update` or `onDisconnect.remove` operation, allowed or denied, once per registration. The in-page sandbox records it in `RtdbConnectionLifecycle.register`; the SharedWorker host and the Node host run the same host module (`packages/cli/src/serve/worker/host.ts`), which validates a registration through that same path. `pyric verify` decides each recorded registration again under the candidate rules at its point in the session: an allowed registration they deny is `now-denied`, a denied one they allow is `now-allowed`. The write a registration makes when the connection ends is a captured write like any other.",
  evidence: "Oracles `rtdb-modular-ondisconnect-rules`, `rtdb-modular-ondisconnect-operations-cancel` and `rules-rtdb-r28-stdlib-presence-timing` are replayed through `packages/conformance/test/rtdb-verify/session-verify-ondisconnect-replay.test.ts` across in-process session capture, `SharedWorker` (`applyServeInit` + `rtdb.onDisconnect*`), and Node host `.pyric/last-session.json` (`runVerify`), asserting registration-time allow/deny recording across `set`, `setWithPriority`, `update` and `remove` and `now-denied` / `now-allowed` candidate rule verdicts. `packages/pyric/test/database/replay.test.ts`, `test/apps/rtdb-verify-reads-and-denials` and CDD assertion `rtdb-modular#VR3` pin the unit and browser scenarios.",
  oracleObservations: ["rtdb-modular-ondisconnect-rules", "rtdb-modular-ondisconnect-operations-cancel", "rules-rtdb-r28-stdlib-presence-timing"],
  conformanceTests: ["packages/conformance/test/rtdb-verify/session-verify-ondisconnect-replay.test.ts", "packages/pyric/test/database/replay.test.ts", "test/apps/rtdb-verify-reads-and-denials/scenario.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
});
