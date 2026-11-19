import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: [
    'persistentLocalCache',
    'memoryLocalCache',
    'persistentSingleTabManager',
    'persistentMultipleTabManager',
    'memoryEagerGarbageCollector',
    'memoryLruGarbageCollector',
  ],
  api: 'persistentLocalCache / memoryLocalCache / persistentSingleTabManager / persistentMultipleTabManager / memoryEagerGarbageCollector / memoryLruGarbageCollector',
  behavior:
    'Returns distinct tagged cache, tab-manager, and garbage-collector configuration tokens whose `kind` discriminator (`persistent`, `memory`, `persistentSingleTab`, `PersistentMultipleTab`, `memoryEager`, `memoryLru`) and `toJSON()` serialization match `firebase/firestore`',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/tier1-cache-init-align.test.ts`, oracle: `firestore-offline-cache-init-index-and-refequal.json` (`cacheTokens`) replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-cache-init-index-and-refequal'],
  conformanceTests: [
    'packages/pyric/test/firestore/cache-tokens.test.ts',
    'packages/pyric/test/firestore/tier1-cache-init-align.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
});
