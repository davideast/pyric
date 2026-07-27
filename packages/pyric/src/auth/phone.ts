import type { Auth, User, ConfirmationResult, PhoneAuthCredential, UserInfo } from './types.js';
import { makeAuthError } from './auth-errors.js';
import { resolveUserAuth, mutateUserProvider, mutateUserPhone } from './internal-user.js';

const activeVerifications = new Map<string, string>();

export async function signInWithPhoneNumber(auth: Auth, phoneNumber: string, _appVerifier: unknown): Promise<ConfirmationResult> {
  const verificationId = `vid-mock-${phoneNumber.replace(/\D/g, '')}`;
  activeVerifications.set(verificationId, phoneNumber);
  return {
    verificationId,
    confirm: async (verificationCode: string) => {
      if (verificationCode !== '123456') {
        throw makeAuthError('auth/invalid-verification-code', 'The verification code from SMS/TOTP is invalid. Please check and enter the correct verification code again.');
      }
      return {
        user: {
          uid: `phone-${phoneNumber}`,
          phoneNumber,
          providerData: [{ providerId: 'phone', uid: phoneNumber, phoneNumber }],
          auth,
        } as unknown as User,
        providerId: 'phone',
        operationType: 'signIn',
      };
    },
  };
}

export async function linkWithPhoneNumber(user: User, phoneNumber: string, appVerifier: unknown): Promise<ConfirmationResult> {
  const auth = resolveUserAuth(user);
  const result = await signInWithPhoneNumber(auth, phoneNumber, appVerifier);
  return {
    verificationId: result.verificationId,
    confirm: async (verificationCode: string) => {
      const cred = await result.confirm(verificationCode);
      mutateUserProvider(user, { providerId: 'phone', uid: phoneNumber, phoneNumber } as UserInfo);
      mutateUserPhone(user, phoneNumber);
      return cred;
    },
  };
}

export async function reauthenticateWithPhoneNumber(user: User, phoneNumber: string, appVerifier: unknown): Promise<ConfirmationResult> {
  const auth = resolveUserAuth(user);
  return signInWithPhoneNumber(auth, phoneNumber, appVerifier);
}

export async function updatePhoneNumber(user: User, credential: PhoneAuthCredential): Promise<void> {
  const vid = (credential as any).verificationId || '';
  let phone = activeVerifications.get(vid);
  if (!phone) {
    const digits = vid.startsWith('vid-mock-') ? vid.slice('vid-mock-'.length) : vid.replace(/\D/g, '');
    if (digits) {
      phone = `+${digits}`;
    }
  }
  if (!phone) {
    throw makeAuthError('auth/invalid-verification-id', 'The phone authentication credential is invalid or expired.');
  }
  mutateUserPhone(user, phone);
  mutateUserProvider(user, { providerId: 'phone', uid: phone, phoneNumber: phone } as UserInfo);
}
