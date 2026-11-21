import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'AuthLens.asUser tenant claim isolation',
  behavior: 'Propagates tenant ID to request.auth.token.firebase.tenant for multi-tenant Security Rules evaluation.',
  featureKeys: ['tenant'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
