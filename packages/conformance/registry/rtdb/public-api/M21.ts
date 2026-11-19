import { row } from './section.ts';

export default row({
  order: 220,
  featureKeys: ["serverTimestamp"],
  behavior: "`serverTimestamp()` resolves to a number (epoch ms) on read-back",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"resolves to a number on read-back\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` (prod observation blocked on rules; sandbox locks the contract directly)",
  risk: ["sentinel"],
  riskScore: 2,
  riskReasons: ["asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-servertimestamp-resolves"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 21,
});
