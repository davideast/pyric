import type { User, MultiFactorUser, MultiFactorSession, MultiFactorResolver, MultiFactorAssertion, MultiFactorInfo } from './types.js';

export function multiFactor(user: User): MultiFactorUser {
  if (!(user as any)._multiFactor) {
    (user as any)._multiFactor = {
      enrolledFactors: [],
    };
  }
  const state = (user as any)._multiFactor;
  return {
    enrolledFactors: state.enrolledFactors,
    getSession: () => Promise.resolve({ id: `mfa-session-${user.uid}` } as MultiFactorSession),
    enroll: async (assertion: MultiFactorAssertion, displayName?: string | null) => {
      state.enrolledFactors.push({
        uid: `mfa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        displayName: displayName || 'Factor',
        factorId: assertion.factorId,
        enrollmentTime: new Date().toUTCString(),
      });
    },
    unenroll: async (target: string | MultiFactorInfo) => {
      const targetId = typeof target === 'string' ? target : target.uid;
      const idx = state.enrolledFactors.findIndex((f: any) => f.uid === targetId || f.factorId === targetId);
      if (idx !== -1) {
        state.enrolledFactors.splice(idx, 1);
      }
    },
  };
}

export function getMultiFactorResolver(error: unknown): MultiFactorResolver {
  const customData = (error as any)?.customData || {};
  if (customData.resolver) return customData.resolver;
  return {
    session: { id: 'mfa-session-mock' } as MultiFactorSession,
    hints: [{ uid: 'mfa-hint-1', factorId: 'phone', phoneNumber: '+1 650-***-1234' } as unknown as MultiFactorInfo],
    resolveSignIn: async (_assertion: MultiFactorAssertion) => ({
      user: { uid: 'mfa-user', email: 'user@example.com' } as unknown as User,
      providerId: 'phone',
      operationType: 'signIn',
    }),
  } as unknown as MultiFactorResolver;
}
