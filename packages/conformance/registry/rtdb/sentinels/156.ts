import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["increment"],
  behavior: "`increment(n)` against an existing numeric field adds atomically; negative deltas subtract",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/increment.test.ts` (\"subsequent increments accumulate (positive then negative)\" + \"nested inside an update patch resolves per-field\"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json` — observed `afterSecond: 8` (5+3) then `afterNegative: 6` (8-2).",
  risk: ["specific-field","sentinel","atomicity"],
  riskScore: 5,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-increment-from-missing"],
  conformanceTests: ["packages/pyric/test/database/modular/increment.test.ts"],
  aliases: ["rtdb#156"],
});
