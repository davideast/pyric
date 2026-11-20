import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'PyricFirebaseAuthPlatform.registerWith({bridgeClient})',
  behavior: 'Registers PyricFirebaseAuthPlatform as the active platform interface singleton.',
  featureKeys: ['registerWith'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
