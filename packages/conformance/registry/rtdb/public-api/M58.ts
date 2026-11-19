import { row } from './section.ts';

export default row({
  order: 670,
  featureKeys: ["onValue","query"],
  behavior: "`onValue(query, cb)` only fires when the windowed result changes — writes OUTSIDE the window don't re-fire the listener; writes that displace a member DO",
  status: "conforms",
  evidence: "`unit:upstream-rtdb-probes.test.ts` (\"one update nulls, mutates, and displaces within a limitToFirst window\") + `unit:modular/queries.test.ts` (\"fires only when the windowed result changes\"); matches oracle `rtdb-modular-onvalue-with-query.json`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-with-query"],
  conformanceTests: ["packages/pyric/test/database/upstream-rtdb-probes.test.ts","packages/pyric/test/database/modular/queries.test.ts"],
  rowNumber: 58,
});
