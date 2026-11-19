import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["increment"],
  behavior: "Concurrent `increment` writes (`set` and `update`) from independent clients deliver optimistic local listener updates synchronously while committing across FIFO server microtasks and wire RPCs to preserve both deltas",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-concurrent-transforms` captures two-client concurrent +2/+3 `increment` updates reaching `incrementTerminal: 5`. Replayed across in-process sandbox (`unit:modular/transaction-contention-cdd.test.ts`, verifying uncommitted `adminGet` 0 while in flight, synchronous optimistic listener delivery, and terminal 5), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-concurrent-transforms.test.ts`).",
  risk: ["listener","sentinel"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-concurrent-transforms"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction-contention-cdd.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-concurrent-transforms.test.ts"],
  aliases: ["rtdb#157"],
});
