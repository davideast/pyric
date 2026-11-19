import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["startAt"],
  behavior: "`startAt(v)` is **inclusive** (the child whose ordered value === v is included)",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-startat-inclusive.json` — seeded positions `[1,2,3,4]`, observed `matched: [2,3,4]` for `startAt(2)` (cursor doc included).",
  risk: ["specific-field","cursor-inclusivity"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts cursor/boundary semantics"],
  oracleObservations: ["rtdb-modular-orderbychild-window","rtdb-modular-orderbykey-window","rtdb-modular-query-startat-inclusive"],
  aliases: ["rtdb#146"],
});
