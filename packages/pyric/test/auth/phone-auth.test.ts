import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  getAuth,
  PhoneAuthProvider,
  PhoneAuthCredential,
  signInWithPhoneNumber,
  linkWithPhoneNumber,
  reauthenticateWithPhoneNumber,
  updatePhoneNumber,
} from '../../src/auth/index.js';

describe('Phone Auth offline challenge-response (CDD)', () => {
  test('PhoneAuthProvider and PhoneAuthCredential satisfy instanceof checks', () => {
    const cred = PhoneAuthProvider.credential('vid-123', '123456');
    expect(cred instanceof PhoneAuthCredential).toBe(true);
    expect(cred.providerId).toBe('phone');
    expect(cred.verificationId).toBe('vid-123');
    expect(cred.verificationCode).toBe('123456');
  });

  test('signInWithPhoneNumber returns ConfirmationResult that signs user in', async () => {
    const app = initializeSandbox({ projectId: 'test-phone-auth' });
    const auth = getAuth(app);
    const confirmation = await signInWithPhoneNumber(auth, '+16505551234', null);
    expect(confirmation.verificationId).toContain('vid-mock-');

    const cred = await confirmation.confirm('123456');
    expect(cred.user.phoneNumber).toBe('+16505551234');
    expect(cred.providerId).toBe('phone');
    expect(cred.operationType).toBe('signIn');
  });

  test('linkWithPhoneNumber adds phone data to existing user', async () => {
    const app = initializeSandbox({ projectId: 'test-link-phone' });
    const auth = getAuth(app);
    const initialConf = await signInWithPhoneNumber(auth, '+16505550000', null);
    const { user } = await initialConf.confirm('123456');

    const linkConf = await linkWithPhoneNumber(user, '+16505559999', null);
    const linkedCred = await linkConf.confirm('123456');
    expect(linkedCred.user.phoneNumber).toBe('+16505559999');
  });

  test('reauthenticateWithPhoneNumber and updatePhoneNumber execute cleanly', async () => {
    const app = initializeSandbox({ projectId: 'test-reauth-phone' });
    const auth = getAuth(app);
    const initialConf = await signInWithPhoneNumber(auth, '+16505550000', null);
    const { user } = await initialConf.confirm('123456');

    const reauthConf = await reauthenticateWithPhoneNumber(user, '+16505550000', null);
    expect(reauthConf.verificationId).toBeDefined();

    const cred = PhoneAuthProvider.credential('vid', '123456');
    await updatePhoneNumber(user, cred);
    expect(user.phoneNumber).toBe('+16505550000');
  });
});
