import { row } from './section.ts';

export default row({
  order: 540,
  featureKeys: ["runTransaction"],
  behavior: "Concurrent `runTransaction` calls across clients interleave over FIFO microtasks and wire RPCs, retrying conflicting update functions up to 25 times before rejecting with a codeless plain `Error('maxretry')`",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-concurrent-transforms` captures two-client contention (`committed: [true, true]`, `retryObserved: true`, `finalSnapshotsSorted: [1, 2]`, `transactionTerminal: 2`, cold callback counts `[2, 3]` with the +1 per-client speculative-null pass documented in `rtdb-modular#160` by-design and `rtdb-modular#M37b`). Replayed across in-process sandbox (`unit:modular/transaction-contention-cdd.test.ts` warm counts `[1, 2]`, re-entrant `[0, 10]`, 25-attempt codeless `Error('maxretry')`), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-concurrent-transforms.test.ts`).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-concurrent-transforms"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction-contention-cdd.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-concurrent-transforms.test.ts"],
  rowNumber: 37,
});
