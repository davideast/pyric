import { listenersCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 280,
  featureKeys: ["onValue"],
  behavior: "`onValue` fires again after every write that CHANGES the value at the watched path; a write that leaves the watched subtree byte-identical (a no-change re-write, or an ancestor/descendant write that doesn't alter this path) is suppressed (DB-B8)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-onvalue-initial-descendant-and-suppression` records re-fires on mutating writes and suppression on identical re-writes and sibling writes; replayed alongside `unit:modular/no-change-suppression.test.ts` and `unit:modular/negative-zero-write.test.ts`.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-onvalue-initial-descendant-and-suppression"],
  conformanceTests: ["packages/pyric/test/database/modular/negative-zero-write.test.ts", "packages/pyric/test/database/modular/no-change-suppression.test.ts", "packages/pyric/test/database/modular/sandbox-target.test.ts", ...listenersCaptureTests],
  rowNumber: 27,
});
