import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 300,
  featureKeys: ["onValue"],
  behavior: "`onValue` initial-fire for an absent path delivers `val=null, exists=false` (matches matrix expectation locked by oracle for sentinel/listener shape)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-initial-descendant-and-suppression` records `exists: false` and `val: null` on initial subscribe to an absent path; replayed alongside `unit:modular/sandbox-target.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-initial-descendant-and-suppression"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...listenersCaptureTests],
  rowNumber: 29,
});
