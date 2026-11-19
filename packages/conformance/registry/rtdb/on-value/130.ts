import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Subsequent `set(ref, …)` fires the listener with the new value",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-onvalue-fires-on-set.json` — observed 1 fire per `set()` (1+1+1 = 3 total: initial-null, after-first-set, after-second-set).",
  risk: ["listener-fire-count","listener"],
  riskScore: 4,
  riskReasons: ["asserts a specific listener fire count","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-onvalue-fires-on-set"],
  aliases: ["rtdb#130"],
});
