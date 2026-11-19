import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["ref","set"],
  behavior: "`set(ref, value)` replaces the value at the path",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"round-trips a primitive value\" + \"round-trips nested objects\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` (prod observation blocked on rules; sandbox locks the contract directly)",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-set-then-get-roundtrip"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 10,
});
