import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["or"],
  behavior: "`or(...)` composite — at least one sub-filter matches",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts` (\"or() matches docs where any sub-filter matches\"), oracle: `packages/conformance/observations/firestore/firestore-or-composite.json` (4 seeded docs; `or(where('x','==',1), where('y','==',2))` returned the exact union `{match-both, match-x, match-y}` — no implicit index required against cloud Firestore)",
  risk: ["composite-filter"],
  riskScore: 2,
  riskReasons: ["asserts composite filter semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-or-composite"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
