import { row } from './section.ts';

export default row({
  order: 460,
  featureKeys: ["ref","update","runTransaction"],
  behavior: "`runTransaction(ref, fn, options?)` resolves to `{ committed: boolean, snapshot: DataSnapshot }` for the happy path — the update fn return value is written, committed is `true`, and `snapshot.val()` reflects the committed value",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/transaction.test.ts` (\"resolves to { committed: boolean, snapshot } with the committed value\"); matches oracle observations `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` + `rtdb-modular-runtransaction-returns-committed-snapshot.json` (against digame-mas, fb-js-sdk 12.19.0)",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-success","rtdb-modular-runtransaction-warm-client-speculation"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts"],
  rowNumber: 37,
});
