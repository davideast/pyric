import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["startAfter"],
  behavior: "`startAfter(v)` is **exclusive**",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` — `startAfter(2) + endBefore(5)` matched positions `[3,4]` (cursor `2` dropped).",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  oracleObservations: ["rtdb-modular-startafter-endbefore-exclusive"],
  aliases: ["rtdb#148"],
});
