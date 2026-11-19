import { row } from './section.ts';

export default row({
  order: 900,
  featureKeys: ["onDisconnect"],
  behavior: "`onDisconnect(ref)` returns the Firebase-shaped five-method handle; registration methods and `cancel()` return acknowledged Promises",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-registration`; sandbox `unit:database/on-disconnect.test.ts`.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-registration"],
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts"],
  rowNumber: 77,
});
