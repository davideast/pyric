import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 160,
  featureKeys: ["update"],
  behavior: "Overlapping multi-path updates (one path is a descendant of another) reject before any path is written",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-multipath-update-and-write-order`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multipath-update-and-write-order"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 16,
});
