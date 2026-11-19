import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["PersistentCacheIndexManager", "getPersistentCacheIndexManager", "enablePersistentCacheIndexAutoCreation", "disablePersistentCacheIndexAutoCreation", "deleteAllPersistentCacheIndexes", "setIndexConfiguration"],
  api: "PersistentCacheIndexManager / Index auto-creation",
  behavior: "Config tokens and index manager controller accepted as honest inert runtime tokens without failing execution",
  status: "conforms",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/persistence-tokens.test.ts"],
});
