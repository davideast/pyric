import { row } from './section.ts';

export default row({
  order: 960,
  featureKeys: ["onDisconnect"],
  behavior: "`OnDisconnect.setWithPriority(value, priority)` writes both the value and RTDB priority metadata when the disconnect queue drains.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-operations-cancel` captures export-format priority 7; sandbox `unit:database/on-disconnect.test.ts` replays the value and priority.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-operations-cancel"],
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts"],
  rowNumber: 83,
});
