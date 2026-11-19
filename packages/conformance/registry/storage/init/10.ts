import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ['getStorage', 'getStorageSandbox'],
  behavior: 'Unrecognized handle (not produced by a factory) throws `TypeError` "not a FirebaseStorage handle"',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence: '`unit:service.test.ts` ("rejects an object that was not produced by a factory")',
  conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
  exceptionReason:
    'Pyric-native TARGET_SYMBOL brand guard rejecting non-factory objects with a clear TypeError at the sandbox seam.',
});
