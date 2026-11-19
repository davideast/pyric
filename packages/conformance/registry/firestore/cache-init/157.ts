import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: [
    'PersistentCacheIndexManager',
    'getPersistentCacheIndexManager',
    'enablePersistentCacheIndexAutoCreation',
    'disablePersistentCacheIndexAutoCreation',
    'deleteAllPersistentCacheIndexes',
    'setIndexConfiguration',
  ],
  api: 'PersistentCacheIndexManager / Index auto-creation',
  behavior:
    '`getPersistentCacheIndexManager(db)` returns `null` for memory-cache handles and a per-handle singleton `PersistentCacheIndexManager` (`type: "PersistentCacheIndexManager"`) for persistent-cache handles; index auto-creation and deletion helpers return `undefined` synchronously, and `setIndexConfiguration` resolves `Promise<void>`',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/persistence-tokens.test.ts`, oracle: `firestore-offline-cache-init-index-and-refequal.json` (`persistentCacheIndexManager`) replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-cache-init-index-and-refequal'],
  conformanceTests: [
    'packages/pyric/test/firestore/cache-index-manager.test.ts',
    'packages/pyric/test/firestore/persistence-tokens.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
});
