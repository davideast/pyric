import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseAuthException',
  behavior: 'Translates bridge auth error codes into standard Firebase error codes (e.g. ERROR_WRONG_PASSWORD, ERROR_USER_NOT_FOUND).',
  featureKeys: ['firebaseAuthException'],
  flipped: 'unit-backed',
});
