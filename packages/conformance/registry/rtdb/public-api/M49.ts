import { row } from './section.ts';

export default row({
  order: 580,
  featureKeys: ["ref","query","orderByChild","startAt","endAt"],
  behavior: "`query(ref, orderByChild(p), startAt(v), endAt(w))` window is BOTH-INCLUSIVE — children whose ordered field === `v` or === `w` are included",
  status: "conforms",
  evidence: "`unit:upstream-rtdb-probes.test.ts` (deep orderByChild nested path) + `unit:modular/queries.test.ts` (\"returns children whose ordered child is within [startAt, endAt] inclusive\"); matches oracle `rtdb-modular-orderbychild-window.json`",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-orderbychild-window"],
  conformanceTests: ["packages/pyric/test/database/upstream-rtdb-probes.test.ts","packages/pyric/test/database/modular/queries.test.ts"],
  rowNumber: 49,
});
