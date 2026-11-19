import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';
import { retryAuthTooManyRequests } from '../../src/oracle-run-auth-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#3',
  rowIds: ['auth#3', 'auth#20', 'auth#23'],
  description:
    'Unswapped canonical firebase/auth imports resolve to upstream Firebase Auth without sandbox helpers, and createUserWithEmailAndPassword auto-signs in a non-anonymous user with input email and null profile fields.',
  async observe() {
    return withClientAuthProbeSession(async ({ auth, authSdk, nextEmail, trackUid }) => {
      const authConfig = (auth as unknown as { config?: { apiHost?: unknown } }).config;
      const inputEmail = nextEmail('create-shape');
      const cred = await retryAuthTooManyRequests('auth-createuser-shape', () =>
        authSdk.createUserWithEmailAndPassword(auth, inputEmail, 'ProbePassword!123'),
      );
      trackUid(cred.user.uid);

      let resolvedApiHost: string | null = null;
      if (typeof authConfig?.apiHost === 'string') {
        resolvedApiHost = authConfig.apiHost;
      }

      return {
        canonicalImportBoundary: {
          getAuthIsFunction: typeof authSdk.getAuth === 'function',
          hasSandboxNamespaceOnModule: 'sandbox' in authSdk,
          hasMockSignInResultOnModule: 'mockSignInResult' in authSdk,
          hasTakeAuthMailOnModule: 'takeAuthMail' in authSdk,
          hasSandboxPropertyOnAuth: 'sandbox' in (auth as unknown as Record<string, unknown>),
          apiHost: resolvedApiHost,
          authNameMatchesAppName: auth.name === auth.app.name,
        },
        createUserAutoSignInAndShape: {
          autoSignedInAsCurrentUser: auth.currentUser === cred.user,
          currentUserUidMatchesCreatedUid:
            auth.currentUser?.uid === cred.user.uid && cred.user.uid.length > 0,
          operationType: cred.operationType,
          credentialProviderId: cred.providerId,
          userShape: {
            isAnonymous: cred.user.isAnonymous,
            emailMatchesInput: cred.user.email === inputEmail,
            displayName: cred.user.displayName,
            photoURL: cred.user.photoURL,
            phoneNumber: cred.user.phoneNumber,
            emailVerified: cred.user.emailVerified,
            providerIds: cred.user.providerData.map((entry) => entry.providerId),
          },
        },
      };
    });
  },
};
