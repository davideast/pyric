import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['getStorage', 'getStorageSandbox'],
  behavior: '`options.rules` parsed eagerly -- malformed rules throw `SyntaxError` at config time',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence: '`unit:storage/sandbox/rules.test.ts` (parse errors propagate from `parseStorageRules`)',
  conformanceTests: ['packages/rules/test/storage/sandbox/rules.test.ts'],
  exceptionReason:
    'Pyric-native in-process StorageOptions.rules compilation on getStorageSandbox; production Firebase deploys Storage security rules server-side rather than through the client SDK.',
});
