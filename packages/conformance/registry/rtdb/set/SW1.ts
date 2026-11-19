import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["set", "update", "push", "setPriority", "setWithPriority", "onDisconnect"],
  behavior: "Across the in-page sandbox, SharedWorker, and Node host planes, a write whose value, priority or update map the SDK refuses (NaN, Infinity, `undefined`, a function, an invalid key, an update map that is not an object) throws synchronously at the call with the SDK's text, sends nothing, and leaves stored data unchanged: `set`, `update`, `push`, `setPriority`, `setWithPriority` and `onDisconnect().set`, `setWithPriority` and `update`",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-sync-write-and-disconnect-validation.json` (firebase 12.19.0) locks synchronous throws, scrubbed SDK error strings, `push(ref, undefined)` 1-arg key minting, and unchanged stored data across all 26 cases, replayed verbatim on the in-page sandbox (`capture-normalization-and-validation.test.ts`), SharedWorker, and Node host (`rtdb-normalization-and-validation.test.ts`). Both the in-page sandbox and the served client run these checks synchronously before queuing or framing; `packages/cli/test/serve/worker/rtdb-invalid-writes.test.ts`, `test/apps/node-rtdb-invalid-writes/scenario.ts`, and `packages/pyric/test/database/cdd/public-operations.test.ts` pin each plane.",
  notes: "Transactions that return such a value are #1373's; `push(ref, undefined)` is the 1-arg key-only overload and mints a 20-char key without throwing.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-sync-write-and-disconnect-validation"],
  conformanceTests: ["packages/cli/test/serve/worker/rtdb-invalid-writes.test.ts", "test/apps/node-rtdb-invalid-writes/scenario.ts", "packages/pyric/test/database/cdd/public-operations.test.ts", "packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts"],
});
