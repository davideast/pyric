import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: [
    'Auth.generatePasswordResetLink',
    'Auth.generateEmailVerificationLink',
    'Auth.generateSignInWithEmailLink',
    'Auth.generateVerifyAndChangeEmailLink',
  ],
  api: 'auth.generatePasswordResetLink / generateEmailVerificationLink / generateSignInWithEmailLink / generateVerifyAndChangeEmailLink',
  behavior:
    'Out-of-band email action link generators are not implemented in `pyric-admin/auth` and reject explicitly.',
  status: 'unsupported',
  automation: 'unsupported',
  exceptionReason:
    'Out-of-band email action link generators are not yet implemented in pyric-admin/auth; calls reject explicitly.',
  conformanceTests: [
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
});
