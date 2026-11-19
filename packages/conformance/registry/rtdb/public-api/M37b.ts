import { row } from './section.ts';

export default row({
  order: 480,
  featureKeys: ["ref","runTransaction"],
  behavior: "Cold clients invoke the update fn first with speculative `null` and then with the current seeded value across in-process and served planes, so abort-if-missing aborts without mutating the seeded value while warm handles invoke once with the cached value (RT-16)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtransaction-current-value-arg` (`[null, seeded]`) and `rtdb-modular-transaction-then-set` key `abortIfMissing` replayed across sandbox (`unit:modular/oracle-conformance-transactions.test.ts`, `packages/pyric/test/database/cdd/capture-transaction-then-set.test.ts`), served SharedWorker, and served Node host (`packages/cli/test/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts`).",
  risk: ["specific-field","atomicity"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-current-value-arg","rtdb-modular-transaction-then-set"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts","packages/pyric/test/database/modular/oracle-conformance-transactions.test.ts","packages/pyric/test/database/cdd/capture-transaction-then-set.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts"],
  rowNumber: 37,
});
