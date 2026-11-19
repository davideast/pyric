import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 400,
  featureKeys: ["ref","remove","off"],
  behavior: "`off(ref, eventType?, callback?)` variants: `off(ref, 'value')` / `off(ref, 'child_added')` / `off(ref, eventType, cb)` remove the targeted subset; returned-unsubscribe from `onChild*` is equivalent to `off(ref, eventType, cb)`",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-off-targeted-and-child-registrars` records targeted callback detachment via `off(ref, 'value', cb)`, event-kind detachment via `off(ref, 'child_added')`, and `onChildAdded` unsubscribe equivalence; replayed alongside `unit:modular/sandbox-child-events.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-targeted-and-child-registrars"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts", ...listenersCaptureTests],
  rowNumber: 48,
});
