import { row } from './section.ts';

export default row({
  order: 980,
  featureKeys: ["getDatabase"],
  behavior: "`Database` is exported as a runtime constructor value and handles returned by `getDatabase()` satisfy Firebase's observable prototype and `instanceof` contract.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtime-class-identity`; sandbox row assertion `rtdb-modular#M85` replays runtime identity.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtime-class-identity"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-runtime-identity.test.ts"],
  rowNumber: 85,
});
