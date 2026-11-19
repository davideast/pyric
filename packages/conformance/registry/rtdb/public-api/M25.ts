import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 260,
  featureKeys: ["remove"],
  behavior: "Rules-denied remove throws the same plain-`Error` `PERMISSION_DENIED` shape",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-rules-validate-and-denied-writes`; `unit:modular/sandbox-target.test.ts`, `unit:denial-context.test.ts`, and multi-plane capture replays.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-rules-validate-and-denied-writes"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", "packages/pyric/test/database/denial-context.test.ts", ...updatesCaptureTests],
  rowNumber: 25,
});
