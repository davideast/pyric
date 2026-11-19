import { row } from './section.ts';

export default row({
  order: 630,
  featureKeys: ["limitToFirst"],
  behavior: "`limitToFirst(N)` keeps the lowest-ranked N children (post-ordering, pre-filter)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/queries.test.ts` (\"limitToFirst takes the lowest-ranked window\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (firstPositions `[1,2]`).",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-limittofirst-vs-limittolast"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts"],
  rowNumber: 54,
});
