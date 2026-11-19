import { row } from './section.ts';

export default row({
  order: 500,
  featureKeys: ["onValue"],
  behavior: "`options.applyLocally` controls whether the in-flight optimistic value fans out to `onValue` listeners -- default `true` (apply locally before commit); `false` suppresses intermediate fires so listeners see only the committed value",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/transaction.test.ts` (\"applyLocally: true (default) -- listener sees initial + committed value\" + \"applyLocally: false -- listener sees only the committed value\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-options-applylocally.json` (single-client harness: both branches produce 2 fires (initial + commit) -- divergence vs prod's documented multi-client suppression would surface under contention, which the sandbox doesn't model)",
  risk: ["listener","atomicity"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-options-applylocally"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts"],
  rowNumber: 37,
});
