import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "The returned ref `r = push(parent, value)` is usable in follow-up ops: `get(r)`, `set(r, …)`, `remove(r)`",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json` — observed all 4 follow-up ops succeed through the returned ref (`refIsUsableForFollowupOps: true`).",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["rtdb-modular-push-with-value"],
  aliases: ["rtdb#127"],
});
