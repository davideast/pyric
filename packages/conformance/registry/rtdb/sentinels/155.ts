import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["increment"],
  behavior: "`increment(n)` against a **missing** field starts at 0 (so `increment(5)` lands as `5`)",
  status: "conforms",
  evidence: "Sandbox aligned (modular `increment` export now present): `unit:modular/increment.test.ts` (\"increment against a missing field starts from 0\"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json` — observed `afterFirst: 5` from `increment(5)` against an absent `count` field.",
  risk: ["specific-field","sentinel"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-increment-from-missing"],
  conformanceTests: ["packages/pyric/test/database/modular/increment.test.ts"],
  conformanceChecks: [{"finding":"DB-GAP","observation":"rtdb-modular-increment-from-missing","expect":{"threw":false},"probe":"packages/pyric/test/database/modular/increment.test.ts","guards":"increment() is implemented and starts from 0 against a missing field."}],
  aliases: ["rtdb#155"],
});
