import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 320,
  featureKeys: ["ref","onChildAdded","onChildChanged","onChildRemoved","onChildMoved"],
  behavior: "`onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved` - plain-ref subscription surface",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-off-targeted-and-child-registrars` exercises all four plain-reference child listener registrars (`onChildAdded`, `onChildChanged`, `onChildRemoved`, and priority-driven `onChildMoved`); replayed alongside `unit:modular/sandbox-child-events.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-targeted-and-child-registrars"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts", ...listenersCaptureTests],
  rowNumber: 31,
});
