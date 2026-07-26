import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  getAuth,
  signInWithPhoneNumber,
  multiFactor,
  FactorId,
  TotpSecret,
  TotpMultiFactorGenerator,
  PhoneMultiFactorGenerator,
  PhoneAuthProvider,
  getMultiFactorResolver,
} from '../../src/auth/index.js';

describe('MFA and TOTP in-memory state machine (CDD)', () => {
  test('FactorId and TotpSecret verify correctly', async () => {
    expect(FactorId.PHONE).toBe('phone');
    expect(FactorId.TOTP).toBe('totp');

    const app = initializeSandbox({ projectId: 'test-mfa-totp' });
    const auth = getAuth(app);
    const conf = await signInWithPhoneNumber(auth, '+16505551234', null);
    const { user } = await conf.confirm('123456');

    const session = await multiFactor(user).getSession();
    expect(session.id).toContain('mfa-session-');

    const secret = await TotpMultiFactorGenerator.generateSecret(session);
    expect(secret instanceof TotpSecret).toBe(true);
    expect(secret.secretKey).toBe('JBSWY3DPEHPK3PXP');
    expect(secret.generateQrCodeUrl('alice@example.com', 'PyricApp')).toContain('otpauth://totp/');
  });

  test('multiFactor(user).enroll and unenroll mutate enrolled factors', async () => {
    const app = initializeSandbox({ projectId: 'test-mfa-enroll' });
    const auth = getAuth(app);
    const conf = await signInWithPhoneNumber(auth, '+16505551234', null);
    const { user } = await conf.confirm('123456');

    const mfa = multiFactor(user);
    expect(mfa.enrolledFactors).toHaveLength(0);

    const phoneCred = PhoneAuthProvider.credential('vid', '123456');
    const phoneAssertion = PhoneMultiFactorGenerator.assertion(phoneCred);
    await mfa.enroll(phoneAssertion, 'My Phone');

    expect(mfa.enrolledFactors).toHaveLength(1);
    expect(mfa.enrolledFactors[0]?.displayName).toBe('My Phone');
    expect(mfa.enrolledFactors[0]?.factorId).toBe('phone');

    const totpSecret = new TotpSecret('KEY', 'SHA1', 30, 6);
    const totpAssertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, '123456');
    await mfa.enroll(totpAssertion, 'My Authenticator');

    expect(mfa.enrolledFactors).toHaveLength(2);

    await mfa.unenroll(mfa.enrolledFactors[0]!);
    expect(mfa.enrolledFactors).toHaveLength(1);
    expect(mfa.enrolledFactors[0]?.factorId).toBe('totp');
  });

  test('getMultiFactorResolver resolves MFA challenge error', async () => {
    const mockError = {
      code: 'auth/multi-factor-auth-required',
      customData: {
        resolver: {
          session: { id: 'session-123' },
          hints: [{ uid: 'hint-1', factorId: 'phone', phoneNumber: '+1 650-***-1234' }],
          resolveSignIn: async () => ({ user: { uid: 'user-resolved' }, providerId: 'phone', operationType: 'signIn' }),
        },
      },
    };

    const resolver = getMultiFactorResolver(mockError);
    expect(resolver.session.id).toBe('session-123');
    expect(resolver.hints[0]?.phoneNumber).toBe('+1 650-***-1234');

    const signInAssertion = TotpMultiFactorGenerator.assertionForSignIn('hint-1', '654321');
    const cred = await resolver.resolveSignIn(signInAssertion);
    expect(cred.user.uid).toBe('user-resolved');
  });
});
