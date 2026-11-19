import { row } from './section.ts';

export default row({
  order: 950,
  featureKeys: ["onDisconnect","goOffline"],
  behavior: "**Local lifecycle contract:** disconnect queues are owned per Database client, drain on app deletion, clear without executing on sandbox reset, and are excluded from persisted RTDB snapshots",
  status: "conforms",
  evidence: "The explicit `rtdb-modular#M82` assertion set in `unit:database/on-disconnect.test.ts` covers independent clients, app deletion, reset clearing, and snapshot exclusion; these sandbox-owned boundaries have no production oracle equivalent.",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/on-disconnect.test.ts"],
  rowNumber: 82,
});
