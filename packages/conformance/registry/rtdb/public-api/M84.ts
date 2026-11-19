import { row } from './section.ts';

export default row({
  order: 970,
  featureKeys: ["onDisconnect"],
  behavior: "Clean `goOffline`, app deletion, playground `pagehide`, `MessagePort` close, SharedWorker host-owned RTDB port-lease expiry after silent renderer loss, and Node host socket teardown after forced process termination (`SIGKILL`) drain queued `onDisconnect` operations and flush durable persistence",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-abrupt-exit` replayed across SharedWorker RTDB port-lease expiry with durable persistence and `@pyric/cli/register` `SIGKILL` child termination in `rtdb-ondisconnect-abrupt-exit.test.ts`, alongside `rtdb-integration.test.ts` and single-process lifecycle assertions in `unit:cdd/lifecycle-and-identity.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-abrupt-exit"],
  conformanceTests: ["packages/cli/test/serve/worker/rtdb-integration.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-ondisconnect-abrupt-exit.test.ts", "packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"],
  rowNumber: 84,
});
