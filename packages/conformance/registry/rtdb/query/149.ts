import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["endBefore"],
  behavior: "`endBefore(v)` is **exclusive**",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` — same probe; cursor `5` dropped.",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  oracleObservations: ["rtdb-modular-startafter-endbefore-exclusive"],
  aliases: ["rtdb#149"],
});
