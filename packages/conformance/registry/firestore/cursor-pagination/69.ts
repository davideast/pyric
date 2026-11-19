import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["endAt"],
  behavior: "`endAt(...values)` — inclusive end cursor",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-endat-inclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), endAt(3))` returned exactly `[pos-1, pos-2, pos-3]` — the cursor doc IS included)",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-cursor-endat-inclusive"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
