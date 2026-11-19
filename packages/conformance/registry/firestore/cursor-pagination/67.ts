import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["startAt"],
  behavior: "`startAt(...values)` — inclusive value cursor (one positional per `orderBy` clause)",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-startat-inclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), startAt(3))` returned exactly `[pos-3, pos-4, pos-5]` — the cursor doc IS included)",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-cursor-startat-inclusive"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
