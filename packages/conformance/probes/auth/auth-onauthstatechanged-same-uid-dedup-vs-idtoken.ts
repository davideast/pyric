import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';
import { waitForCondition } from '../../src/oracle-run-stable-shapes.ts';

async function drainAuthMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#30a',
  rowIds: ['auth#30a', 'auth#38a'],
  description:
    'onAuthStateChanged deduplicates consecutive same-uid transitions (staying silent on same-uid re-sign-in), whereas onIdTokenChanged fires on every sign-in and mints a fresh ID token.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ adminAuth, auth, authSdk, nextUid, trackUid }) => {
        const uidA = trackUid(nextUid('dedup-a'));
        const uidB = trackUid(nextUid('dedup-b'));
        const tokenA1 = await adminAuth.createCustomToken(uidA, { rev: 1 });
        const tokenA2 = await adminAuth.createCustomToken(uidA, { rev: 2 });
        const tokenB = await adminAuth.createCustomToken(uidB);

        const labelFor = (u: { uid: string } | null): string => {
          if (u === null) return 'null';
          if (u.uid === uidA) return 'uid-a';
          if (u.uid === uidB) return 'uid-b';
          return 'other';
        };

        const authStateEvents: string[] = [];
        const idTokenEvents: string[] = [];
        const unsubAuth = authSdk.onAuthStateChanged(auth, (u) => {
          authStateEvents.push(labelFor(u));
        });
        const unsubToken = authSdk.onIdTokenChanged(auth, (u) => {
          idTokenEvents.push(labelFor(u));
        });

        try {
          await waitForCondition(
            () => authStateEvents.length >= 1 && idTokenEvents.length >= 1,
            5000,
          );

          const credA1 = await authSdk.signInWithCustomToken(auth, tokenA1);
          await waitForCondition(
            () => authStateEvents.includes('uid-a') && idTokenEvents.includes('uid-a'),
            5000,
          );
          const jwtBeforeReSignIn = await credA1.user.getIdToken();

          const authCountBeforeProfile = authStateEvents.length;
          await authSdk.updateProfile(credA1.user, { displayName: 'Ada Lovelace' });
          await drainAuthMicrotasks();
          const authCountAfterProfile = authStateEvents.length;

          const authCountBeforeSameUid = authStateEvents.length;
          const idTokenCountBeforeSameUid = idTokenEvents.length;
          const credA2 = await authSdk.signInWithCustomToken(auth, tokenA2);
          await waitForCondition(
            () => idTokenEvents.length > idTokenCountBeforeSameUid,
            5000,
          );
          await drainAuthMicrotasks();
          const jwtAfterReSignIn = await credA2.user.getIdToken();
          const authFiredOnSameUidReSignIn =
            authStateEvents.length > authCountBeforeSameUid;
          const idTokenFiredOnSameUidReSignIn =
            idTokenEvents.length > idTokenCountBeforeSameUid;

          await authSdk.signInWithCustomToken(auth, tokenB);
          await waitForCondition(
            () => authStateEvents.includes('uid-b') && idTokenEvents.includes('uid-b'),
            5000,
          );

          return {
            authStateFiredOnProfileUpdate: authCountAfterProfile > authCountBeforeProfile,
            authStateFiredOnSameUidReSignIn: authFiredOnSameUidReSignIn,
            idTokenFiredOnSameUidReSignIn,
            jwtChangedAfterSameUidReSignIn: jwtAfterReSignIn !== jwtBeforeReSignIn,
            authStateSequence: authStateEvents,
            idTokenSequence: idTokenEvents,
          };
        } finally {
          unsubAuth();
          unsubToken();
        }
      },
    );
  },
};
