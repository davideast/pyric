import { row } from './section.ts';

export default row({
  order: 220,
  featureKeys: ["latlng","duration"],
  behavior: "`latlng.value().latitude()/longitude()/distance()` and `duration.value()/time()/abs()` in rules",
  status: "conforms",
  evidence: "Production captures from 2026-07-12 and the 2026-07-21 recapture prove the simulator matches the Firestore Rules Test API verdict-for-verdict on all 3 cases: coordinate and duration bounds plus exact `duration.value(1500, 'ms').seconds()` / `.nanos()` components. `oracle:rules-firestore-duration-and-latlng` — replayed by `unit:rules/oracle-conformance.test.ts`.",
  oracleObservations: ["rules-firestore-duration-and-latlng"],
});
