import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuthPlatform.signOut()',
  behavior: 'Signs out active session via bridge auth.signOut RPC, clearing currentUser and emitting null on streams.',
  featureKeys: ['signOut'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
