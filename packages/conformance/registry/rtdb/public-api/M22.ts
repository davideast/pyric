import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 230,
  featureKeys: ["update","serverTimestamp"],
  behavior: "`serverTimestamp()` sentinels resolve when nested inside multi-path update payloads",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-push-value-and-nested-servertimestamp`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  risk: ["sentinel"],
  riskScore: 2,
  riskReasons: ["asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-push-value-and-nested-servertimestamp"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 22,
});
