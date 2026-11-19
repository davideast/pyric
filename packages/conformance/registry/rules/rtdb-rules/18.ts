import { row } from './section.ts';

export default row({
  order: 180,
  featureKeys: ["child"],
  behavior: "`child()` does not resolve `.` or `..` path segments: `child('./x')` and `child('a/../x')` find nothing where `child('x')` finds a child",
  evidence: "`oracle:rules-rtdb-r18-child-dot-segments` — production ALLOWS a write whose validate requires `newData.child('x').exists()` and DENIES the same data under `child('./x')` and `child('a/../x')`. The simulator matches all 3 cases.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-rtdb-r18-child-dot-segments"],
  constructs: ["rtdb.method.snapshot.child"],
});
