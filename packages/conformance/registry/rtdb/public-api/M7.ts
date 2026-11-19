import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["ref","root"],
  behavior: "`ref.root` returns the root ref of the same target",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ref-navigation-and-absent-get`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ref-navigation-and-absent-get"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 7,
});
