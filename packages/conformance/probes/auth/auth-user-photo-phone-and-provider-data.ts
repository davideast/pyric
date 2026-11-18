import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'user.photoURL, user.phoneNumber, user.providerId, and user.providerData reflect empty anonymous providers, default-null password profiles, and configured account attributes.',
  async observe() {
    return withClientAuthProbeSession(
      async ({
        auth,
        authSdk,
        adminAuth,
        nextUid,
        nextEmail,
        nextPhoneNumber,
        trackUid,
        createProbeUser,
      }) => {
        const anonCred = await authSdk.signInAnonymously(auth);
        trackUid(anonCred.user.uid);
        const anonymousShape = {
          photoURL: anonCred.user.photoURL,
          phoneNumber: anonCred.user.phoneNumber,
          providerId: anonCred.user.providerId,
          providerDataLength: anonCred.user.providerData.length,
        };
        await authSdk.signOut(auth);

        const defaultUid = nextUid('pw-default');
        const defaultEmail = nextEmail('pw-default');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid: defaultUid, email: defaultEmail, password });
        const defaultCred = await authSdk.signInWithEmailAndPassword(
          auth,
          defaultEmail,
          password,
        );
        const firstDefaultProvider = defaultCred.user.providerData[0];
        let defaultProviderEntry: Record<string, unknown> | null = null;
        if (firstDefaultProvider !== undefined) {
          defaultProviderEntry = {
            providerId: firstDefaultProvider.providerId,
            uidMatchesEmail: firstDefaultProvider.uid === defaultEmail,
            emailMatchesAccount: firstDefaultProvider.email === defaultEmail,
            displayName: firstDefaultProvider.displayName,
            photoURL: firstDefaultProvider.photoURL,
            phoneNumber: firstDefaultProvider.phoneNumber,
          };
        }
        const defaultPasswordShape = {
          photoURL: defaultCred.user.photoURL,
          phoneNumber: defaultCred.user.phoneNumber,
          providerId: defaultCred.user.providerId,
          providerDataLength: defaultCred.user.providerData.length,
          defaultProviderEntry,
        };
        await authSdk.signOut(auth);

        const richUid = nextUid('pw-rich');
        const richEmail = nextEmail('pw-rich');
        const richPhoto = 'https://example.com/avatars/grace.png';
        const richPhone = nextPhoneNumber();
        await createProbeUser({
          uid: richUid,
          email: richEmail,
          password,
          displayName: 'Grace Hopper',
          photoURL: richPhoto,
          phoneNumber: richPhone,
        });
        const richCred = await authSdk.signInWithEmailAndPassword(auth, richEmail, password);
        const adminRichRecord = await adminAuth.getUser(richUid);

        return {
          anonymousShape,
          defaultPasswordShape,
          configuredUserShape: {
            photoURL: richCred.user.photoURL,
            phoneNumberMatchesAssigned: richCred.user.phoneNumber === richPhone,
            providerId: richCred.user.providerId,
            clientProviderIdsSorted: richCred.user.providerData
              .map((entry) => entry.providerId)
              .sort(),
            adminProviderIdsSorted: adminRichRecord.providerData
              .map((entry) => entry.providerId)
              .sort(),
          },
        };
      },
    );
  },
};
