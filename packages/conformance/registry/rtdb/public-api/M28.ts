import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 290,
  featureKeys: ["onValue"],
  behavior: "`onValue` fires after a descendant write (the listener sees subtree changes)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-initial-descendant-and-suppression` records parent `onValue` subtree updates after nested descendant `set` and `update` writes; replayed alongside `unit:modular/sandbox-target.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-initial-descendant-and-suppression"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...listenersCaptureTests],
  rowNumber: 28,
});
