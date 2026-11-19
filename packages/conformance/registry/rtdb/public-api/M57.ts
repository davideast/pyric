import { row } from './section.ts';

export default row({
  order: 660,
  featureKeys: ["startAfter","endBefore"],
  behavior: "`startAfter(v)` and `endBefore(v)` are EXCLUSIVE — the boundary value is dropped from the result",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/queries.test.ts` (\"startAfter + endBefore drop the boundary values\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` (positions `[3,4]`, cursors 2 + 5 dropped).",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-startafter-endbefore-exclusive"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts"],
  rowNumber: 57,
});
