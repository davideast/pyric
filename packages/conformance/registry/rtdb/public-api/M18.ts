import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 190,
  featureKeys: ["ref","child","push"],
  behavior: "`push(ref, value)` writes `value` at the new child path",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-push-value-and-nested-servertimestamp`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-push-value-and-nested-servertimestamp"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 18,
});
