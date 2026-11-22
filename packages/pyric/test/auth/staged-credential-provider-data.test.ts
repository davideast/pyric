/**
 * Focused regression tests for:
 *   - #1511: in-page `signInWithCredential` with a staged result updates `user.providerData`
 *   - #1699: `getAdditionalUserInfo().providerId` is `'password'` for email/password flows
 *   - #1698: linking an email credential onto an anonymous user reports `isNewUser: true` and `providerId: 'password'`
 *   - #1693: `verifyBeforeUpdateEmail` with a malformed new address throws `auth/invalid-new-email`
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAdditionalUserInfo,
  getAuth,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
  reauthenticateWithCredential,
  sandbox as authSandbox,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signOut,
  verifyBeforeUpdateEmail,
  type User,
} from '../../src/auth/index.js';

describe('in-page signInWithCredential staged providerData (#1511)', () => {
  it('includes the staged federated provider on both result.user and auth.currentUser', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    const { user } = await createUserWithEmailAndPassword(
      auth,
      'staged@example.com',
      'pw-123456',
    );
    await signOut(auth);

    authSandbox.mockSignInResult(auth, {
      user,
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const result = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential('any-token'),
    );

    const resultProviders = (result.user.providerData ?? []).map((p) => p.providerId);
    const currentProviders = (auth.currentUser?.providerData ?? []).map((p) => p.providerId);
    expect(resultProviders).toEqual(['password', 'google.com']);
    expect(currentProviders).toEqual(['password', 'google.com']);
    expect(result.user).toBe(auth.currentUser);
  });

  it('rebuilds User when the staged user object is frozen', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    const { user } = await createUserWithEmailAndPassword(
      auth,
      'frozen-staged@example.com',
      'pw-123456',
    );
    await signOut(auth);

    const frozenUser = Object.freeze({ ...user }) as User;
    authSandbox.mockSignInResult(auth, {
      user: frozenUser,
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const result = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential('any-token'),
    );

    const providers = (result.user.providerData ?? []).map((p) => p.providerId);
    expect(providers).toEqual(['password', 'google.com']);
    expect(result.user).toBe(auth.currentUser);
  });
});

describe('getAdditionalUserInfo providerId and anonymous link upgrade (#1699, #1698)', () => {
  it('reports providerId password on email/password create, sign-in, credential, and email-link while keeping UserCredential.providerId null', async () => {
    const auth = getAuth(initializeSandbox());

    const created = await createUserWithEmailAndPassword(auth, 'ep@example.com', 'pw-123456');
    expect(created.providerId).toBeNull();
    expect(getAdditionalUserInfo(created)).toEqual({
      isNewUser: true,
      profile: {},
      providerId: 'password',
    });

    await signOut(auth);
    const signedIn = await signInWithEmailAndPassword(auth, 'ep@example.com', 'pw-123456');
    expect(signedIn.providerId).toBeNull();
    expect(getAdditionalUserInfo(signedIn)).toEqual({
      isNewUser: false,
      profile: {},
      providerId: 'password',
    });

    await signOut(auth);
    const viaCred = await signInWithCredential(
      auth,
      EmailAuthProvider.credential('ep@example.com', 'pw-123456'),
    );
    expect(viaCred.providerId).toBeNull();
    expect(getAdditionalUserInfo(viaCred)).toEqual({
      isNewUser: false,
      profile: {},
      providerId: 'password',
    });

    const reauthed = await reauthenticateWithCredential(
      viaCred.user,
      EmailAuthProvider.credential('ep@example.com', 'pw-123456'),
    );
    expect(reauthed.providerId).toBeNull();
    expect(getAdditionalUserInfo(reauthed)).toEqual({
      isNewUser: false,
      profile: {},
      providerId: 'password',
    });

    await signOut(auth);
    await sendSignInLinkToEmail(auth, 'magic@example.com', {
      url: 'https://example.com/finish',
      handleCodeInApp: true,
    });
    const mail = authSandbox.takeAuthMail(auth, 'magic@example.com');
    if (mail === null) {
      throw new Error('expected sign-in link mail');
    }
    const viaLink = await signInWithEmailLink(auth, 'magic@example.com', mail.link);
    expect(viaLink.providerId).toBeNull();
    expect(getAdditionalUserInfo(viaLink)).toEqual({
      isNewUser: true,
      profile: {},
      providerId: 'password',
    });
  });

  it('reports isNewUser true for anonymous email upgrade and isNewUser false for non-anonymous email link (#1698)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    const anon = await signInAnonymously(auth);
    const upgraded = await linkWithCredential(
      anon.user,
      EmailAuthProvider.credential('upgraded@example.com', 'pw-123456'),
    );
    expect(upgraded.providerId).toBeNull();
    expect(upgraded.operationType).toBe('link');
    expect(getAdditionalUserInfo(upgraded)).toEqual({
      isNewUser: true,
      profile: {},
      providerId: 'password',
    });

    await signOut(auth);
    const anonForOauth = await signInAnonymously(auth);
    authSandbox.setAuthFlowResolver(auth, {
      openPopup: async () => ({
        user: anonForOauth.user,
        providerId: 'google.com',
        operationType: 'link',
      }),
      openRedirect: async () => {
        throw new Error('unused');
      },
    });
    const oauthLink = await linkWithPopup(anonForOauth.user, new GoogleAuthProvider());
    expect(oauthLink.providerId).toBe('google.com');
    expect(getAdditionalUserInfo(oauthLink)).toEqual({
      isNewUser: false,
      profile: {},
      providerId: 'google.com',
    });

    // Linking an email credential onto an already non-anonymous user is not an anonymous upgrade.
    const secondLink = await linkWithCredential(
      oauthLink.user,
      EmailAuthProvider.credential('attached@example.com', 'pw-123456'),
    );
    expect(secondLink.providerId).toBeNull();
    expect(getAdditionalUserInfo(secondLink)).toEqual({
      isNewUser: false,
      profile: {},
      providerId: 'password',
    });
  });
});

describe('verifyBeforeUpdateEmail malformed target address (#1693)', () => {
  it('throws auth/invalid-new-email for malformed newEmail while keeping auth/invalid-email on sendPasswordResetEmail', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await createUserWithEmailAndPassword(
      auth,
      'current@example.com',
      'pw-123456',
    );

    for (const malformed of ['not-an-email', '', '@domain.com', 'local@', 'missing-dot@domain']) {
      await expect(verifyBeforeUpdateEmail(user, malformed)).rejects.toMatchObject({
        code: 'auth/invalid-new-email',
      });
    }

    await expect(sendPasswordResetEmail(auth, 'not-an-email')).rejects.toMatchObject({
      code: 'auth/invalid-email',
    });
  });
});
