import type { Auth, User, ConfirmationResult, PhoneAuthCredential } from './types.js';

export async function signInWithPhoneNumber(auth: Auth, phoneNumber: string, _appVerifier: unknown): Promise<ConfirmationResult> {
  const verificationId = `vid-mock-${phoneNumber.replace(/\D/g, '')}`;
  return {
    verificationId,
    confirm: async (_verificationCode: string) => {
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
  const auth = (user as any).auth || { currentUser: user };
  const result = await signInWithPhoneNumber(auth, phoneNumber, appVerifier);
  return {
    verificationId: result.verificationId,
    confirm: async (verificationCode: string) => {
      const cred = await result.confirm(verificationCode);
      if (!(user as any).providerData) (user as any).providerData = [];
      (user as any).providerData.push({ providerId: 'phone', uid: phoneNumber, phoneNumber });
      (user as any).phoneNumber = phoneNumber;
      return cred;
    },
  };
}

export async function reauthenticateWithPhoneNumber(user: User, phoneNumber: string, appVerifier: unknown): Promise<ConfirmationResult> {
  const auth = (user as any).auth || { currentUser: user };
  return signInWithPhoneNumber(auth, phoneNumber, appVerifier);
}

export async function updatePhoneNumber(user: User, _credential: PhoneAuthCredential): Promise<void> {
  (user as any).phoneNumber = `+16505550000`;
}
