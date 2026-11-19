import { row } from './section.ts';

export default row({
  order: 920,
  featureKeys: ["onDisconnect","goOffline","goOnline","onValue"],
  behavior: "`goOffline(db)` drains that client's queue once, listeners observe the disconnect write in server order, and `goOnline(db)` does not resurrect executed operations",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-clean-set`; sandbox clean lifecycle test.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-clean-set"],
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts"],
  rowNumber: 79,
});
