import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#57',
  rowIds: ['auth#57'],
  description:
    'user.uid, user.email, user.displayName, and user.isAnonymous reflect the sign-in source across anonymous and email/password users.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, nextUid, nextEmail, trackUid, createProbeUser }) => {
        const anonCred = await authSdk.signInAnonymously(auth);
        trackUid(anonCred.user.uid);
        const anonymousUser = {
          uidIsNonEmptyString:
            typeof anonCred.user.uid === 'string' && anonCred.user.uid.length > 0,
          email: anonCred.user.email,
          displayName: anonCred.user.displayName,
          isAnonymous: anonCred.user.isAnonymous,
        };
        await authSdk.signOut(auth);

        const uid = nextUid('pw');
        const email = nextEmail('pw');
        const password = 'ProbePassword!123';
        await createProbeUser({
          uid,
          email,
          password,
          displayName: 'Ada Lovelace',
        });
        const pwCred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const passwordUser = {
          uidMatchesCreated: pwCred.user.uid === uid,
          emailMatchesCreated: pwCred.user.email === email,
          displayName: pwCred.user.displayName,
          isAnonymous: pwCred.user.isAnonymous,
        };

        return {
          anonymousUser,
          passwordUser,
        };
      },
    );
  },
};
