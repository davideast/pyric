import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 530,
  featureKeys: ["onValue"],
  behavior: "Committed transaction fans out to `onValue` listeners on the watched path with the new value (default applyLocally behavior)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-rules-validate-and-denied-writes`; `unit:modular/transaction.test.ts` and multi-plane capture replays.",
  risk: ["listener","atomicity"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-rules-validate-and-denied-writes"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts", ...updatesCaptureTests],
  rowNumber: 37,
});
