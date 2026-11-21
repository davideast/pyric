import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'PyricAuthCredentialsProvider.authLensChanges',
  behavior: 'Emits distinct AuthLens transitions driving Firestore operation stamping and listener re-subscription.',
  featureKeys: ['authLensChanges'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
