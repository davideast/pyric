import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuthPlatform.createUserWithEmailAndPassword(email, password)',
  behavior: 'Registers user via bridge auth.createUser RPC and returns UserCredential with isNewUser: true.',
  featureKeys: ['createUserWithEmailAndPassword'],
  status: 'conforms',
  tests: ['packages/flutter-client/test/live_host/auth_live_host_conformance_test.dart'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
