import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["ref","update"],
  behavior: "`update(ref, patch)` shallow-merges top-level keys at the ref's path",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-multipath-update-and-write-order`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multipath-update-and-write-order"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 13,
});
