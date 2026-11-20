import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_CRUD_SUITE, row } from './section.ts';

export default row({
  order: 100,
  api: 'DocumentReference.delete()',
  behavior: 'Deletes document at reference path from Firestore database.',
  featureKeys: ['delete'],
  status: 'conforms',
  tests: [LIVE_HOST_CRUD_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
