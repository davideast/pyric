import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'AuthLens deep equality semantics',
  behavior: 'Compares token claims and tenant attributes by deep collection equality to avoid spurious re-subscriptions.',
  featureKeys: ['AuthLens'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
