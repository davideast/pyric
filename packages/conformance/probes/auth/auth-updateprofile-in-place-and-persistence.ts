import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#62',
  rowIds: ['auth#62'],
  description:
    'updateProfile(user, { displayName, photoURL }) mutates the held User and stored record in place (null clears a field, omitted fields stay intact) without an extra onAuthStateChanged fire and survives signOut -> signInWithEmailAndPassword.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, adminAuth, nextUid, nextEmail, createProbeUser }) => {
        const uid = nextUid('prof');
        const email = nextEmail('prof');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });

        const cred = await authSdk.signInWithEmailAndPassword(auth, email, password);
        const heldUser = cred.user;

        let authStateFires = 0;
        let idTokenFires = 0;
        const unsubAuth = authSdk.onAuthStateChanged(auth, () => {
          authStateFires += 1;
        });
        const unsubToken = authSdk.onIdTokenChanged(auth, () => {
          idTokenFires += 1;
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        const baselineAuthStateFires = authStateFires;
        const baselineIdTokenFires = idTokenFires;

        await authSdk.updateProfile(heldUser, {
          displayName: 'Builder One',
          photoURL: 'https://example.com/avatars/builder.png',
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const afterSetBoth = {
          sameCurrentUserRef: auth.currentUser === heldUser,
          displayName: heldUser.displayName,
          photoURL: heldUser.photoURL,
          passwordProviderDisplayName:
            heldUser.providerData.find((p) => p.providerId === 'password')?.displayName ?? null,
          passwordProviderPhotoURL:
            heldUser.providerData.find((p) => p.providerId === 'password')?.photoURL ?? null,
          extraAuthStateFires: authStateFires - baselineAuthStateFires,
          extraIdTokenFires: idTokenFires - baselineIdTokenFires,
        };

        await authSdk.updateProfile(heldUser, {
          photoURL: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const afterClearPhotoOnly = {
          displayName: heldUser.displayName,
          photoURL: heldUser.photoURL,
          adminDisplayName: (await adminAuth.getUser(uid)).displayName ?? null,
          adminPhotoURL: (await adminAuth.getUser(uid)).photoURL ?? null,
          extraAuthStateFiresTotal: authStateFires - baselineAuthStateFires,
        };

        unsubAuth();
        unsubToken();

        await authSdk.signOut(auth);
        const reSignedIn = await authSdk.signInWithEmailAndPassword(auth, email, password);

        return {
          afterSetBoth,
          afterClearPhotoOnly,
          afterReSignIn: {
            displayName: reSignedIn.user.displayName,
            photoURL: reSignedIn.user.photoURL,
          },
        };
      },
    );
  },
};
