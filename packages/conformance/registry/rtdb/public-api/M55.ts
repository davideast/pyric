import { row } from './section.ts';

export default row({
  order: 640,
  featureKeys: ["limitToLast"],
  behavior: "`limitToLast(N)` keeps the highest-ranked N children",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/queries.test.ts` (\"limitToLast takes the highest-ranked window\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (lastPositions `[4,5]`).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-limittofirst-vs-limittolast"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts"],
  rowNumber: 55,
});
