import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'oracle-backed',
  api: 'User.isEmailVerified',
  behavior: 'Indicates whether the user\'s primary email address has been verified.',
  featureKeys: ['isEmailVerified'],
  oracleObservations: ['auth-swift-email-password-and-error-codes'],
});
