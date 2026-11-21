import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'InternalUserDetails wire deserializer',
  behavior: 'Deserializes bridge user wire payload into InternalUserDetails and provider structures.',
  featureKeys: ['InternalUserDetails'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
