import { row } from './section.ts';

export default row({
  order: 70,
  api: 'FirebaseUser.isEmailVerified',
  behavior: 'Returns true if the user email has been verified, false otherwise.',
  featureKeys: ['isEmailVerified'],
  flipped: 'live-host',
});
