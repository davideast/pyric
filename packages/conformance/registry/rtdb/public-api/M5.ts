import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["ref","child","parent"],
  behavior: "`child(ref, 'sub/path')` composes paths; result inherits the parent's target",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ref-navigation-and-absent-get`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ref-navigation-and-absent-get"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 5,
});
