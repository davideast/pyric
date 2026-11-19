import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["onChildChanged"],
  behavior: "`onChildChanged` fires when an existing child's value changes; does NOT fire for added or removed children",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json` — observed `firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}` (the NEW value, not the prior).",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  oracleObservations: ["rtdb-modular-onchildchanged-fires-on-update"],
  aliases: ["rtdb#135"],
});
