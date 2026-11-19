import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ['getStorage', 'getStorageSandbox'],
  behavior: '`options.dbName` honored on the FIRST call per `Sandbox`; second-call overrides ignored',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence: '`unit:service.test.ts` ("dbName only takes effect on the sandbox\'s first getStorage call")',
  conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
  exceptionReason:
    'Pyric-native StorageOptions.dbName IndexedDB backing-store override on getStorageSandbox; production Cloud Storage has no client-side IndexedDB store.',
});
