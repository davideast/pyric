import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 520,
  featureKeys: ["runTransaction"],
  behavior: "Rules-denied transaction does NOT write -- pre-transaction value at the path is preserved through the rejection",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-rules-validate-and-denied-writes`; `unit:modular/transaction.test.ts`, `packages/cli/test/serve/worker/rtdb-denial-context.test.ts`, and multi-plane capture replays.",
  risk: ["atomicity","rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts transaction/batch atomicity","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-rules-validate-and-denied-writes"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts","packages/cli/test/serve/worker/rtdb-denial-context.test.ts", ...updatesCaptureTests],
  rowNumber: 37,
});
