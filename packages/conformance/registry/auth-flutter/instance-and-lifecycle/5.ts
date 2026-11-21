import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseAuthPlatform.dispose()',
  behavior: 'Disposes platform resources, canceling bridge subscriptions and closing reactive stream controllers.',
  featureKeys: ['dispose'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
