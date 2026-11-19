import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['getStorageSandbox'],
  behavior: 'Two `getStorageSandbox(ctx)` calls on the same context return the SAME wrapper (identity-stable)',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence: '`unit:service.test.ts` ("returns the same handle for repeated calls on the same context")',
  conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
  exceptionReason:
    'Pyric-native SandboxContext handle caching on getStorageSandbox(ctx); firebase/storage caches by (FirebaseApp, bucketUrl) rather than SandboxContext.',
});
