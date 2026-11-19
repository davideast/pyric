import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 360,
  featureKeys: ["onChildChanged"],
  behavior: "`onChildChanged` does NOT fire for added or removed children - those go to the other event listeners",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-off-targeted-and-child-registrars` records `onChildChanged` firing exclusively on existing-child updates and remaining silent on child additions and removals; replayed alongside `unit:modular/sandbox-child-events.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-targeted-and-child-registrars"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts", ...listenersCaptureTests],
  rowNumber: 44,
});
