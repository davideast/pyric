import { row } from './section.ts';

export default row({
  order: 420,
  featureKeys: [],
  behavior: "Members of `auth` read null when nobody is signed in, `child()` with a dotted or empty key and `hasChild('.priority')` read as production reads them, and `.length` counts UTF-16 code units (SP-5, SP-6 refuted)",
  evidence: "`oracle:rules-rtdb-r49-value-edges` (captured 2026-10-26, 13 cases) records production ALLOWING a signed-out read under `auth.token.admin != true` and under `auth.uid == null`, treating `child('a.b')` as a missing child, `child('')` as the node itself and `hasChild('.priority')` as true on a leaf with a priority, and DENYING three emoji under `length <= 3`. The simulator matches these 11 verdicts; row #36 records the two `query` cases where it does not.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts signed-out auth members, child() keys and string length allow and deny as production does"],
  oracleObservations: ["rules-rtdb-r49-value-edges"],
  constructs: ["rtdb.binding.auth.uid", "rtdb.binding.auth.token", "rtdb.method.snapshot.child", "rtdb.method.snapshot.hasChild", "rtdb.method.string.length"],
});
