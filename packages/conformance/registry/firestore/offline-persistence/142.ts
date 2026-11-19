import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["clearIndexedDbPersistence"],
  api: "clearIndexedDbPersistence",
  behavior: "Maps to `Sandbox.clearPersistence()` — actually wipes the persisted blob (honest, not a no-op); already a no-op when persistence was never enabled",
  status: "conforms",
  evidence: "`unit:firestore/persistence-network.test.ts`",
  conformanceTests: ["packages/pyric/test/firestore/persistence-network.test.ts"],
});
