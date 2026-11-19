import { row } from './section.ts';

export default row({
  order: 330,
  featureKeys: ["ref","child","parent","onChildAdded"],
  behavior: "`onChildAdded` replays each existing direct child of the parent ref on subscribe (one fire per existing key)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` (\"replays existing direct children on subscribe — one fire per key\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json` (seeded `{k1,k2,k3}`, observed `firedKeys: ['k1','k2','k3']`).",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onchildadded-initial-replay"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts"],
  rowNumber: 41,
});
