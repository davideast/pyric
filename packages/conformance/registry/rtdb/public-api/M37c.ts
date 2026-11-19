import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 490,
  featureKeys: ["update"],
  behavior: "The update fn arg is a defensive deep clone -- mutating it does NOT corrupt the stored tree (matters for code that does `current.count++; return undefined` and expects abort to preserve state)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-rules-validate-and-denied-writes`; `unit:modular/transaction.test.ts` and multi-plane capture replays.",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-rules-validate-and-denied-writes"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts", ...updatesCaptureTests],
  rowNumber: 37,
});
