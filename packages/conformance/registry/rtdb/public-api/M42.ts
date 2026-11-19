import { row } from './section.ts';

export default row({
  order: 340,
  featureKeys: ["child","onChildAdded"],
  behavior: "After subscribe, `onChildAdded` fires exactly once per new direct child write; snapshot carries `{key, val}` of the new child",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` (\"fires exactly once per NEW direct child after subscribe\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json` (`postSubscribeFires: 1`, `lastFire: {key:'k3', val:{v:3}}`).",
  risk: ["listener-fire-count","specific-field","listener"],
  riskScore: 5,
  riskReasons: ["asserts a specific listener fire count","asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onchildadded-post-subscribe"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts"],
  rowNumber: 42,
});
