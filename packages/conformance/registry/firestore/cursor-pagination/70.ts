import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["endBefore"],
  behavior: "`endBefore(...values)` — exclusive end cursor",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-endbefore-exclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), endBefore(3))` returned exactly `[pos-1, pos-2]` — the cursor doc is EXCLUDED)",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-cursor-endbefore-exclusive"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
