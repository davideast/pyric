import { row } from './section.ts';

export default row({
  order: 990,
  featureKeys: ["get"],
  behavior: "`DataSnapshot` is exported as a runtime constructor value and snapshots returned by reads/listeners satisfy Firebase's observable prototype and `instanceof` contract.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtime-class-identity`; sandbox row assertion `rtdb-modular#M86` replays runtime identity.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtime-class-identity"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-runtime-identity.test.ts"],
  rowNumber: 86,
});
