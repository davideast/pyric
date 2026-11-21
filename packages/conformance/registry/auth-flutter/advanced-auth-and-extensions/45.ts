import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuthPlatform.setPersistence(persistence)',
  behavior: 'Configures session persistence mode across local storage or in-memory sessions.',
  featureKeys: ['setPersistence'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_tokens_mutations_live_host_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
