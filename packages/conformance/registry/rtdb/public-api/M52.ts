import { row } from './section.ts';

export default row({
  order: 610,
  featureKeys: ["orderByChild","equalTo"],
  behavior: "`orderByChild(p) + equalTo(v)` returns ALL children whose field at `p` === `v` — no uniqueness enforced",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/queries.test.ts` (\"returns ALL children whose ordered field === the supplied value\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json` (both 'b'-grouped children returned).",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-equalTo-filter"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts"],
  rowNumber: 52,
});
