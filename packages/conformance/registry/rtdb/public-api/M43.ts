import { row } from './section.ts';

export default row({
  order: 350,
  featureKeys: ["child","onChildChanged"],
  behavior: "`onChildChanged` has NO initial replay; fires once when an existing direct child's value transitions; snapshot carries the NEW value",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` (\"does NOT fire on subscribe (no initial replay)\" + \"fires once when an existing child transitions to a new value; snapshot carries NEW val\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json` (`firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}`).",
  risk: ["listener-fire-count","listener"],
  riskScore: 4,
  riskReasons: ["asserts a specific listener fire count","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onchildchanged-fires-on-update"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts"],
  rowNumber: 43,
});
