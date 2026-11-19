import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 170,
  featureKeys: ["update","set","remove"],
  behavior: "`update()` applies when called, as `set()` does, so a client's writes land in call order: `update(r, { x: 2 })` then `set(child(r, 'x'), 3)` stores 3, update then remove leaves the path empty, and a listener sees the update before `update()` returns (RT-1)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-multipath-update-and-write-order`; `unit:modular/update-write-order.test.ts` and multi-plane capture replays.",
  risk: ["timing"],
  riskScore: 2,
  riskReasons: ["asserts event ordering"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-multipath-update-and-write-order"],
  conformanceTests: ["packages/pyric/test/database/modular/update-write-order.test.ts", ...updatesCaptureTests],
  rowNumber: 16,
});
