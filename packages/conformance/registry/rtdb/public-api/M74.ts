import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 830,
  featureKeys: ["ref","onValue"],
  behavior: "`onValue(ref, cb, { onlyOnce: true })` fires once then auto-unsubscribes (DB-B12)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-onlyonce-and-unsub-return` records `onlyOnce: true` firing once on initial snapshot (and once on absent paths) and suppressing subsequent writes; replayed alongside `unit:modular/onvalue-onlyonce.test.ts`.",
  risk: ["listener-fire-count","listener"],
  riskScore: 4,
  riskReasons: ["asserts a specific listener fire count","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-onlyonce-and-unsub-return"],
  conformanceTests: ["packages/pyric/test/database/modular/onvalue-onlyonce.test.ts", ...listenersCaptureTests],
  rowNumber: 74,
});
