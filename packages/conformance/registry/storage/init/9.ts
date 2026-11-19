import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ['getStorage', 'getStorageSandbox'],
  behavior: 'The `TARGET_SYMBOL` brand keeps each handle bound to its owning sandbox service and identity',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence: '`unit:service.test.ts` (distinct contexts share one service while retaining distinct handles)',
  risk: ['structural'],
  riskReasons: ['structural / routing-only claim'],
  conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
  exceptionReason:
    'Pyric-native TARGET_SYMBOL handle branding for sandbox dispatch; production firebase/storage has no sandbox target symbol.',
});
