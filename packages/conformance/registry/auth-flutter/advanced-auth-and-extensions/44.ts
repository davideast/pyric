import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthPlatform.useAuthEmulator(host, port)',
  behavior: 'Directs client auth operations to designated host and port emulator endpoint.',
  featureKeys: ['useAuthEmulator'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
