import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 310,
  featureKeys: ["onValue"],
  behavior: "The `onValue` return value is an unsubscribe function; calling it stops further fires",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-onlyonce-and-unsub-return` records `typeof unsub === 'function'` and zero further callbacks after invoking the returned unsubscribe function; replayed alongside `unit:modular/sandbox-target.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-onlyonce-and-unsub-return"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...listenersCaptureTests],
  rowNumber: 30,
});
