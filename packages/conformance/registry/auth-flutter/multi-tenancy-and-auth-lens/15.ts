import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'PyricAuthCredentialsProvider.currentAuthLens',
  behavior: 'Derives active AuthLens (asUser with uid, tenant, and custom claims, or anon).',
  featureKeys: ['currentAuthLens'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
