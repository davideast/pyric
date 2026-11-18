import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

const PROBE_PASSWORD = 'ProbePassword!123';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'User.providerData reflects linked providers accurately (empty on custom-token birth, populated on linkWithCredential, preserved across signInWithCredential with EmailAuthProvider.credential, and emptied on unlink without re-anonymizing).',
  async observe() {
    return withClientAuthProbeSession(
      async ({ adminAuth, auth, authSdk, nextEmail, nextUid, trackUid }) => {
        const uid = trackUid(nextUid('provdata'));
        const email = nextEmail('provdata');
        const customToken = await adminAuth.createCustomToken(uid);

        const initialCred = await authSdk.signInWithCustomToken(auth, customToken);
        const initialProviderIds = initialCred.user.providerData.map((item) => item.providerId);
        const initialIsAnonymous = initialCred.user.isAnonymous;

        const emailCred = authSdk.EmailAuthProvider.credential(email, PROBE_PASSWORD);
        const linkedCred = await authSdk.linkWithCredential(initialCred.user, emailCred);
        const afterLinkProviderIds = linkedCred.user.providerData.map((item) => item.providerId);
        const linkedPasswordEntry = linkedCred.user.providerData.find(
          (item) => item.providerId === 'password',
        );
        const linkedEmailMatches = linkedPasswordEntry?.email === email;
        const uidPreservedOnLink = linkedCred.user.uid === uid;

        await authSdk.signOut(auth);

        const freshEmailCred = authSdk.EmailAuthProvider.credential(email, PROBE_PASSWORD);
        const credSignIn = await authSdk.signInWithCredential(auth, freshEmailCred);
        const signInWithEmailCredentialSucceeded = credSignIn.operationType === 'signIn';
        const sameUidAfterCredentialSignIn = credSignIn.user.uid === uid;
        const afterCredentialSignInProviderIds = credSignIn.user.providerData.map(
          (item) => item.providerId,
        );

        const unlinkedUser = await authSdk.unlink(credSignIn.user, 'password');
        const afterUnlinkProviderIds = unlinkedUser.providerData.map((item) => item.providerId);
        const remainsNonAnonymousAfterUnlink = unlinkedUser.isAnonymous === false;

        await authSdk.reload(unlinkedUser);
        const afterReloadProviderIds = unlinkedUser.providerData.map((item) => item.providerId);

        return {
          initialProviderIds,
          initialIsAnonymous,
          afterLinkProviderIds,
          linkedEmailMatches,
          uidPreservedOnLink,
          signInWithEmailCredentialSucceeded,
          sameUidAfterCredentialSignIn,
          afterCredentialSignInProviderIds,
          afterUnlinkProviderIds,
          remainsNonAnonymousAfterUnlink,
          afterReloadProviderIds,
        };
      },
    );
  },
};
