import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  api: 'UserPlatform.tenantId',
  behavior: 'Exposes Google Cloud Identity Platform tenant ID associated with user.',
  featureKeys: ['tenantId'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
