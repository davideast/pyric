import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 890,
  featureKeys: ["set","update","runTransaction"],
  behavior: "`.validate` rules are enforced on modular sandbox writes through `set`, atomic `update`, and `runTransaction`; a descendant validation failure rejects the operation without changing state.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-rules-validate-and-denied-writes`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  risk: ["atomicity","rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts transaction/batch atomicity","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-rules-validate-and-denied-writes"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 76,
});
