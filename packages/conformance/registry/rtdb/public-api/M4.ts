import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["ref","root"],
  behavior: "`ref(db, path?)` returns a path-tagged `DatabaseReference`; default is root while `''` throws synchronously",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ref-navigation-and-absent-get`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ref-navigation-and-absent-get"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 4,
});
