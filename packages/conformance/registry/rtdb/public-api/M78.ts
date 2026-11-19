import { row } from './section.ts';

export default row({
  order: 910,
  featureKeys: ["onDisconnect","set"],
  behavior: "An acknowledged `onDisconnect(ref).set(value)` registration does not mutate server data before the client disconnects",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-ondisconnect-registration`; sandbox registration/no-mutation test.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-ondisconnect-registration"],
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts"],
  rowNumber: 78,
});
