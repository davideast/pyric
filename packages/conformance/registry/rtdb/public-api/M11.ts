import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["ref","set"],
  behavior: "`set(ref, null)` deletes the subtree at the path",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"set(ref, null) deletes the path\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-remove-vs-set-null"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 11,
});
