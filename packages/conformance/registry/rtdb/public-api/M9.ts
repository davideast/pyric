import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["get"],
  behavior: "`get` on an absent path resolves to `{ val: null, exists: false }` (matches `DataSnapshot.val()` contract)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ref-navigation-and-absent-get`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ref-navigation-and-absent-get"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 9,
});
