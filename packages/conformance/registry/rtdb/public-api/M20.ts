import { updatesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 210,
  featureKeys: ["serverTimestamp"],
  behavior: "`serverTimestamp()` returns the `{ \".sv\": \"timestamp\" }` sentinel marker the wire encoder recognises",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-push-value-and-nested-servertimestamp`; `unit:modular/sandbox-target.test.ts` and multi-plane capture replays.",
  risk: ["sentinel"],
  riskScore: 2,
  riskReasons: ["asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-push-value-and-nested-servertimestamp"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", ...updatesCaptureTests],
  rowNumber: 20,
});
