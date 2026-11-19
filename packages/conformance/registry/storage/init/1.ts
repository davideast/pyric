import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getStorageSandbox'],
  behavior: '`getStorageSandbox(ctx)` returns a tagged sandbox-target handle (frozen identity)',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence: '`unit:service.test.ts`',
  risk: ['structural'],
  riskReasons: ['structural / routing-only claim'],
  conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
  exceptionReason:
    'Pyric-native getStorageSandbox(ctx) factory binding a SandboxContext; firebase/storage has no context-scoped initializer counterpart to capture.',
});
