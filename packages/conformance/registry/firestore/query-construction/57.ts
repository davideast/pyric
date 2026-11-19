import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["and"],
  behavior: "`and(...)` composite — every sub-filter matches",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts` (\"and() requires every sub-filter\"), oracle: `packages/conformance/observations/firestore/firestore-and-composite.json` (4 seeded docs; `and(where('x','==',1), where('y','==',2))` returned only the intersection `{match-both}`)",
  risk: ["composite-filter"],
  riskScore: 2,
  riskReasons: ["asserts composite filter semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-and-composite"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
