import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#58',
  rowIds: ['auth#58'],
  description:
    'user.emailVerified defaults to false on anonymous and unverified password users, reflects true when verified on the account, and matches Admin UserRecord.emailVerified.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, adminAuth, nextUid, nextEmail, trackUid, createProbeUser }) => {
        const anonCred = await authSdk.signInAnonymously(auth);
        trackUid(anonCred.user.uid);
        const anonymousEmailVerified = anonCred.user.emailVerified;
        const anonAdminRecord = await adminAuth.getUser(anonCred.user.uid);
        const anonymousAdminEmailVerified = anonAdminRecord.emailVerified;
        await authSdk.signOut(auth);

        const uid = nextUid('ev');
        const email = nextEmail('ev');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });

        const unverifiedCred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const unverifiedClientFlag = unverifiedCred.user.emailVerified;
        const unverifiedAdminFlag = (await adminAuth.getUser(uid)).emailVerified;
        await authSdk.signOut(auth);

        await adminAuth.updateUser(uid, { emailVerified: true });
        const verifiedCred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const verifiedClientFlag = verifiedCred.user.emailVerified;
        const verifiedAdminFlag = (await adminAuth.getUser(uid)).emailVerified;

        return {
          anonymousEmailVerified,
          anonymousAdminEmailVerified,
          unverifiedClientFlag,
          unverifiedAdminFlag,
          verifiedClientFlag,
          verifiedAdminFlag,
        };
      },
    );
  },
};
