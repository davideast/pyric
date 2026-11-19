import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["startAt"],
  behavior: "`startAt(snapshot)` overload — extracts orderBy field values from the snapshot, positioning against the NORMALIZED orderBy (implicit `__name__`), so it disambiguates equal-valued docs and is **legal without an explicit orderBy** (FS-B8). A VALUE cursor with more values than explicit orderBy clauses throws `invalid-argument` (\"Too many arguments\").",
  evidence: "`unit:sandbox-target.test.ts`, `unit:admin-compat/implicit-order-name.test.ts` (snapshot cursor w/o orderBy), `unit:admin-compat/cursors.test.ts` (value-cursor too-many-args throws with `.code`)",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `invalid-argument`"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-startat-snapshot-implicit-name"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/sandbox/firestore/admin-compat/cursors.test.ts","packages/pyric/test/sandbox/firestore/admin-compat/implicit-order-name.test.ts"],
});
