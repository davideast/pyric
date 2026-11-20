import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Remote client session isolation',
  behavior: 'Isolates client auth state and token subscriptions to clientSessionId without mutating browser session.',
  featureKeys: ['sessionIsolation'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
