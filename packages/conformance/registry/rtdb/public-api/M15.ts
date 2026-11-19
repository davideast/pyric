import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["update"],
  behavior: "`update(rootRef, { '/a/x': v1, '/b/y': v2 })` is a multi-path atomic write -- all paths land or none do",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-multipath-update-and-write-order`; `unit:upstream-rtdb-probes.test.ts`, `unit:modular/sandbox-target.test.ts`, and multi-plane capture replays.",
  risk: ["sentinel","atomicity"],
  riskScore: 4,
  riskReasons: ["asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multipath-update-and-write-order"],
  conformanceTests: ["packages/pyric/test/database/upstream-rtdb-probes.test.ts","packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 15,
});
