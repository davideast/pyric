import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 270,
  featureKeys: ["ref","onValue"],
  behavior: "`onValue(ref, cb)` fires immediately on subscribe with the current value at the path",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-initial-descendant-and-suppression` records immediate initial delivery on seeded paths; replayed across sandbox, SharedWorker, and Node host alongside `unit:modular/sandbox-target.test.ts`.",
  risk: ["listener","timing"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-initial-descendant-and-suppression"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...listenersCaptureTests],
  rowNumber: 26,
});
