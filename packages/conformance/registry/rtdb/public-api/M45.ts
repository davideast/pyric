import { row } from './section.ts';

export default row({
  order: 370,
  featureKeys: ["child","set","remove","onChildRemoved"],
  behavior: "`onChildRemoved` has NO initial replay; fires once when a direct child is deleted (via `remove(child)` or `set(child, null)`); snapshot carries the PRIOR (now-removed) value",
  status: "conforms",
  evidence: "`unit:upstream-rtdb-probes.test.ts` (parent wipe fan-out via remove(parent) / set(parent, scalar)) + `unit:modular/sandbox-child-events.test.ts` (single-child delete carries PRIOR val, and the removed child's own and descendants' priorities in `priority` and `exportVal()`, on a reference and a query); matches oracle `rtdb-modular-onchildremoved-fires-on-delete.json`",
  risk: ["listener-fire-count","listener"],
  riskScore: 4,
  riskReasons: ["asserts a specific listener fire count","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onchildremoved-fires-on-delete"],
  conformanceTests: ["packages/pyric/test/database/upstream-rtdb-probes.test.ts","packages/pyric/test/database/modular/sandbox-child-events.test.ts"],
  rowNumber: 45,
});
