import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["or","and"],
  behavior: "Nested `or` / `and` — full composite tree",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts` (\"nested or/and — the canonical composite pattern\"), oracle: `packages/conformance/observations/firestore/firestore-nested-or-and-composite.json` (6 seeded docs; `or(and(where('x','==',1), where('y','==',2)), where('z','==',3))` returned `{inner-and-match, outer-z-match, both-branches}` — exact boolean union as predicted)",
  risk: ["composite-filter"],
  riskScore: 2,
  riskReasons: ["asserts composite filter semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-nested-or-and-composite"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
