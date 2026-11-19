import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["startAfter"],
  behavior: "`startAfter(...values)` — exclusive value cursor",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-startafter-exclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), startAfter(3))` returned exactly `[pos-4, pos-5]` — the cursor doc is EXCLUDED)",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-cursor-startafter-exclusive"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
