import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Basic success — `runTransaction(ref, current => (current ?? 0) + 1)` resolves `{ committed: true, snapshot }` where `snapshot.val()` is the new value",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `committed: true, snapVal: 1` after running `current => (current ?? 0) + 1` against an empty ref.",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-on-rules-denied-path","rtdb-modular-runtransaction-options-applylocally","rtdb-modular-runtransaction-success"],
  aliases: ["rtdb#158"],
});
