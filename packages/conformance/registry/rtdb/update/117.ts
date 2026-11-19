import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Multi-path update — `update(parentRef, { 'a/x': 1, 'b/y': 2 })` lands BOTH writes atomically at distinct subtrees (RTDB's most distinctive feature; this is the \"fan-out\" pattern)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-atomic.json` — observed `aX: 1, bY: 2` both readable after a single update call.",
  risk: ["sentinel","atomicity"],
  riskScore: 4,
  riskReasons: ["asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-update-multipath-atomic"],
  aliases: ["rtdb#117"],
});
