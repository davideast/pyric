import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "The returned value from `onValue(ref, cb)` is the unsubscribe function (NOT an object); calling it removes the listener",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-onlyonce-and-unsub-return` records `typeof unsub === 'function'` and verifies calling the returned function detaches only that listener while sibling listeners continue firing; replayed alongside `unit:modular/listener-lifecycle-cdd.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-onlyonce-and-unsub-return"],
  conformanceTests: ["packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts", ...listenersCaptureTests],
  aliases: ["rtdb#132"],
});
