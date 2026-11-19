import { row } from './section.ts';

export default row({
  order: 930,
  featureKeys: ["onDisconnect","set","update","remove"],
  behavior: "Disconnect queues support `set`, `update`, `remove`, exact cancellation, parent cancellation of queued descendants, and captured parent-set/child-set/child-cancel coalescing that preserves the existing canceled child",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-operations-cancel`; sandbox operation/cancellation test, including the captured parent-set + child-cancel merge result. A queued server value is a leaf, as the SDK's onDisconnect tree holds it: cancelling a path below it leaves it whole, in the sandbox (`on-disconnect.test.ts`) and on the served host (`host/rtdb-instances.test.ts`).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-operations-cancel"],
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts","packages/cli/test/serve/worker/host/rtdb-instances.test.ts"],
  rowNumber: 80,
});
