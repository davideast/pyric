import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["update"],
  behavior: "`null` value in a shallow update deletes that key",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-multipath-update-and-write-order`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multipath-update-and-write-order"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 14,
});
