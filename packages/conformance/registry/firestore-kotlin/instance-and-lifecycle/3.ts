import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFirestore.firestoreSettings',
  behavior: 'Configures host, sslEnabled, persistenceEnabled, and cacheSizeBytes via FirebaseFirestoreSettings.',
  featureKeys: ['settings'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
