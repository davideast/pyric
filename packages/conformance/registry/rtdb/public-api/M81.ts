import { row } from './section.ts';

export default row({
  order: 940,
  featureKeys: ["onDisconnect","goOffline"],
  behavior: "Rules are evaluated when a disconnect operation is registered and re-evaluated when it executes; an execution-time denial leaves server state unchanged",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-rules` with successful normal-write controls in both rule phases; sandbox rules-timing test.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-rules"],
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts"],
  rowNumber: 81,
});
