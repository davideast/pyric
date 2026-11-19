import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: [
    'GeoPoint',
    'GrpcStatus',
    'initializeFirestore',
    'setLogFunction',
    'Firestore.getAll',
    'Firestore.listCollections',
    'Firestore.recursiveDelete',
    'Firestore.bulkWriter',
  ],
  api: 'GeoPoint / GrpcStatus / initializeFirestore / setLogFunction and Firestore.getAll / listCollections / recursiveDelete / terminate / bulkWriter / bundle / settings',
  behavior:
    'Deferred `firebase-admin/firestore` top-level exports and administrative `Firestore` methods throw `PyricDeferredApiError` naming the unmodeled API instead of failing as `undefined` or silently no-oping.',
  status: 'unsupported',
  automation: 'unsupported',
  exceptionReason:
    'Deferred firebase-admin/firestore exports and bulk/admin maintenance methods are not yet implemented and throw PyricDeferredApiError explicitly.',
  conformanceTests: ['packages/pyric-admin/test/deferred/subpath-exports.test.ts'],
  evidence: 'Pinned in `packages/pyric-admin/test/deferred/subpath-exports.test.ts`.',
});
