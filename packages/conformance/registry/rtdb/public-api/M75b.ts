import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 860,
  featureKeys: ["onChildAdded","onChildChanged","onChildRemoved","onChildMoved","query"],
  behavior: "All child-listener functions accept `Query` inputs; add/change/remove events respect the active query window.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-query-window-child-listeners` records bounded `orderByChild` + `limitToFirst` child listener replay, window entry/eviction, in-window updates/reorders, and out-of-window suppression; replayed alongside `unit:modular/listener-lifecycle-cdd.test.ts` and `unit:modular/sandbox-child-events.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-window-child-listeners"],
  conformanceTests: ["packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts", "packages/pyric/test/database/modular/sandbox-child-events.test.ts", ...listenersCaptureTests],
});
