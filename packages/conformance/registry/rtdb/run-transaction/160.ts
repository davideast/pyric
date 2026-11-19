import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "A cold client invokes the update fn first with speculative `null` and then with the current seeded value, whereas a client warmed by a prior read, write, or active listener invokes it once with the cached value",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtransaction-current-value-arg` captures the cold two-call `[null, seeded]` sequence and `rtdb-modular-runtransaction-warm-client-speculation` captures the warm single-call case; replayed across sandbox (`unit:modular/oracle-conformance-transactions.test.ts`), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts`).",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-current-value-arg","rtdb-modular-runtransaction-warm-client-speculation","rtdb-modular-runtransaction-options-applylocally","rtdb-modular-runtransaction-success"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-transactions.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts"],
  aliases: ["rtdb#160"],
});
