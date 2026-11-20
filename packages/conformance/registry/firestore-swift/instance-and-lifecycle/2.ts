import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'Firestore.firestore(app:)',
  behavior: 'Returns a Firestore instance associated with the specified FirebaseApp.',
  featureKeys: ['firestoreApp'],
  status: 'conforms',
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
