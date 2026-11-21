import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_INSTANCE_SUITE, row } from './section.ts';

export default row({
  order: 50,
  api: 'Firestore.settings',
  behavior: 'Provides custom client configuration including host, sslEnabled, dispatchQueue, and cacheSettings.',
  featureKeys: ['settings'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_INSTANCE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
