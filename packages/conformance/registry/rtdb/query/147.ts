import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["endAt"],
  behavior: "`endAt(v)` is **inclusive**",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbychild-window.json` — `startAt(2) + endAt(4)` matched positions `[2,3,4]` (endAt(4) included its boundary value).",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  oracleObservations: ["rtdb-modular-orderbychild-window","rtdb-modular-orderbykey-window"],
  aliases: ["rtdb#147"],
});
