import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["ref","set","remove"],
  behavior: "`remove(ref)` is equivalent to `set(ref, null)` (same end state)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"remove and set(null) produce identical end-state\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-remove-vs-set-null"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 12,
});
