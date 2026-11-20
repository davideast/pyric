import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Firestore snapshot re-subscription supervisor',
  behavior: 'Automatically re-subscribes active Firestore snapshot listeners under the new AuthLens upon auth transition.',
  featureKeys: ['snapshots', 'authLens'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
