import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Concurrent contention -- if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-concurrent-transforms` captures two-client concurrent `runTransaction` contention (`committed: [true, true]`, `retryObserved: true`, `finalSnapshotsSorted: [1, 2]`, `transactionTerminal: 2`, cold callback counts `[2, 3]` with +1 per-client cold speculative `null` per `rtdb-modular#160` and `rtdb-modular#M37b`). Replayed with warm callback counts `[1, 2]` and 25-attempt codeless `Error('maxretry')` across sandbox (`unit:modular/transaction-contention-cdd.test.ts`), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-concurrent-transforms.test.ts`).",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-concurrent-transforms"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction-contention-cdd.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-concurrent-transforms.test.ts"],
  aliases: ["rtdb#161"],
});
