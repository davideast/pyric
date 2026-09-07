/**
 * Provider sign-in carries a profile photo end to end — sandbox target.
 *
 * Covers the two in-page upsert paths a provider sign-in can take:
 * `createSignInCredential` (the account-picker mint behind an
 * `AuthFlowResolver`) and `recordProviderSignIn` (the commit step that folds
 * ANY resolver-supplied `User` into the user DB). Both must land the photo on
 * the stored record, on the live `User`, and on the matching `providerData`
 * entry — and neither may blank a stored photo when the identity carries none.
 *
 * An identity-supplied photo always wins. When the identity carries none, the
 * backend mints a default at creation — the second describe block below covers
 * that policy: federated providers get one, everyone else stays null.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  isSignInWithEmailLink,
  sandbox as authSandbox,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithEmailLink,
  signInWithPopup,
  type Auth,
  type AuthFlowResolver,
  type SignInIdentitySpec,
  type User,
} from '../../src/auth/index.js';
import { defaultAvatarDataUri } from '../../src/auth/sandbox/default-avatar.js';

const PHOTO = 'https://cdn.example.com/avatars/ada.png';
const OTHER_PHOTO = 'https://cdn.example.com/avatars/ada-2.png';
const PROVIDER_ID = 'google.com';

function googleAuth(): Auth {
  const auth = getAuth(initializeSandbox());
  authSandbox.setAuthProviderConfig(auth, PROVIDER_ID, true);
  return auth;
}

/** Resolver that mints through the backend's account-picker path — the wiring
 *  the served in-page fallback gives `ServeAuthHelper`. */
function pickerResolver(auth: Auth, spec: SignInIdentitySpec): AuthFlowResolver {
  const mint = async () =>
    authSandbox.createSignInCredential(auth, { providerId: PROVIDER_ID, spec });
  return { openPopup: mint, openRedirect: mint };
}

/** A resolver-supplied `User` with no `providerData` — the bare shape a host
 *  picker or a mock hands back before `recordProviderSignIn` sees it. */
function bareUser(uid: string, email: string, photoURL: string | null): User {
  return {
    uid,
    email,
    displayName: null,
    photoURL,
    isAnonymous: false,
    getIdToken: async () => `fake-${uid}`,
    getIdTokenResult: async () => ({
      token: `fake-${uid}`,
      claims: { sub: uid },
      expirationTime: new Date().toISOString(),
      issuedAtTime: new Date().toISOString(),
      authTime: new Date().toISOString(),
    }),
  };
}

function bareResolver(user: User): AuthFlowResolver {
  const mint = async () => ({ user, providerId: PROVIDER_ID, operationType: 'signIn' as const });
  return { openPopup: mint, openRedirect: mint };
}

function storedPhotoUrl(auth: Auth, uid: string): string | null | undefined {
  return authSandbox.listUsers(auth).find((user) => user.uid === uid)?.photoUrl;
}

describe('provider sign-in photo (sandbox)', () => {
  it('picker mint with a photo sets user.photoURL and the providerData entry', async () => {
    const auth = googleAuth();
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com', photoUrl: PHOTO }),
    );

    expect(cred.user.photoURL).toBe(PHOTO);
    expect(
      cred.user.providerData?.find((entry) => entry.providerId === PROVIDER_ID)?.photoURL,
    ).toBe(PHOTO);
    expect(auth.currentUser?.photoURL).toBe(PHOTO);
    expect(storedPhotoUrl(auth, 'ada')).toBe(PHOTO);
  });

  it('picker mint without a photo gets the default avatar, not null', async () => {
    const auth = googleAuth();
    const expected = defaultAvatarDataUri({
      uid: 'ada',
      displayName: null,
      email: 'ada@example.com',
    });
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com' }),
    );

    expect(cred.user.photoURL).toBe(expected);
    expect(
      cred.user.providerData?.find((entry) => entry.providerId === PROVIDER_ID)?.photoURL,
    ).toBe(expected);
    expect(storedPhotoUrl(auth, 'ada')).toBe(expected);
  });

  it('a bare resolver User carrying a photo records it on a fresh stored identity', async () => {
    const auth = googleAuth();
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      bareResolver(bareUser('ada', 'ada@example.com', PHOTO)),
    );

    expect(cred.user.photoURL).toBe(PHOTO);
    expect(
      cred.user.providerData?.find((entry) => entry.providerId === PROVIDER_ID)?.photoURL,
    ).toBe(PHOTO);
    expect(storedPhotoUrl(auth, 'ada')).toBe(PHOTO);
    expect(authSandbox.exportUsers(auth).find((seed) => seed.uid === 'ada')?.photoUrl).toBe(PHOTO);
  });

  it('a later provider sign-in with a photo refreshes the stored photo', async () => {
    const auth = googleAuth();
    await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      bareResolver(bareUser('ada', 'ada@example.com', PHOTO)),
    );
    await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      bareResolver(bareUser('ada', 'ada@example.com', OTHER_PHOTO)),
    );

    expect(storedPhotoUrl(auth, 'ada')).toBe(OTHER_PHOTO);
    expect(auth.currentUser?.photoURL).toBe(OTHER_PHOTO);
  });

  it('re-signing in without a photo does NOT clear the stored one (bare identity)', async () => {
    const auth = googleAuth();
    await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      bareResolver(bareUser('ada', 'ada@example.com', PHOTO)),
    );
    await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      bareResolver(bareUser('ada', 'ada@example.com', null)),
    );

    expect(storedPhotoUrl(auth, 'ada')).toBe(PHOTO);
    expect(auth.currentUser?.photoURL).toBe(PHOTO);
  });

  it('re-signing in without a photo does NOT clear the stored one (picker same-email reuse)', async () => {
    const auth = googleAuth();
    await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com', photoUrl: PHOTO }),
    );
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { email: 'ada@example.com' }),
    );

    expect(cred.user.uid).toBe('ada');
    expect(cred.user.photoURL).toBe(PHOTO);
    expect(storedPhotoUrl(auth, 'ada')).toBe(PHOTO);
  });
});

describe('default avatar assignment (sandbox)', () => {
  it('a bare federated identity with no photo is born with the default avatar', async () => {
    const auth = googleAuth();
    const expected = defaultAvatarDataUri({
      uid: 'ada',
      displayName: null,
      email: 'ada@example.com',
    });
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      bareResolver(bareUser('ada', 'ada@example.com', null)),
    );

    expect(cred.user.photoURL).toBe(expected);
    expect(
      cred.user.providerData?.find((entry) => entry.providerId === PROVIDER_ID)?.photoURL,
    ).toBe(expected);
    expect(storedPhotoUrl(auth, 'ada')).toBe(expected);
  });

  it('an identity-supplied photo wins over the mint', async () => {
    const auth = googleAuth();
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com', photoUrl: PHOTO }),
    );

    expect(cred.user.photoURL).toBe(PHOTO);
    expect(storedPhotoUrl(auth, 'ada')).toBe(PHOTO);
  });

  it('email/password creation stays null — prod returns no photo for it', async () => {
    const auth = getAuth(initializeSandbox());
    const cred = await createUserWithEmailAndPassword(auth, 'pw@example.com', 'password123');

    expect(cred.user.photoURL).toBeNull();
    expect(storedPhotoUrl(auth, cred.user.uid)).toBeNull();
  });

  it('anonymous sign-in stays null', async () => {
    const auth = getAuth(initializeSandbox());
    const cred = await signInAnonymously(auth);

    expect(cred.user.photoURL).toBeNull();
    expect(storedPhotoUrl(auth, cred.user.uid)).toBeNull();
  });

  it('email-link account creation stays null', async () => {
    const auth = getAuth(initializeSandbox());
    await sendSignInLinkToEmail(auth, 'link@example.com', {
      url: 'https://app.example.com/finish',
      handleCodeInApp: true,
    });
    const mail = authSandbox.takeAuthMail(auth)!;
    expect(isSignInWithEmailLink(auth, mail.link)).toBe(true);
    const cred = await signInWithEmailLink(auth, 'link@example.com', mail.link);

    expect(cred.user.photoURL).toBeNull();
    expect(storedPhotoUrl(auth, cred.user.uid)).toBeNull();
  });

  it('a seeded federated SeedUser without a photo gets the mint and re-exports stably', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'seeded', email: 'seeded@example.com', password: 'pw', providerId: 'google.com' },
    ]);

    const expected = defaultAvatarDataUri({
      uid: 'seeded',
      displayName: null,
      email: 'seeded@example.com',
    });
    expect(storedPhotoUrl(auth, 'seeded')).toBe(expected);

    const exported = authSandbox.exportUsers(auth);
    expect(exported.find((seed) => seed.uid === 'seeded')?.photoUrl).toBe(expected);

    // Re-seeding the export into a fresh sandbox is a fixed point: the photo
    // is now caller-supplied, so the mint never runs again.
    const other = getAuth(initializeSandbox());
    authSandbox.seedUsers(other, exported);
    expect(authSandbox.exportUsers(other)).toEqual(exported);
  });

  it('a seeded password SeedUser stays photo-less', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [{ uid: 'bare', email: 'bare@example.com', password: 'pw' }]);

    expect(storedPhotoUrl(auth, 'bare')).toBeNull();
    expect('photoUrl' in authSandbox.exportUsers(auth)[0]!).toBe(false);
  });

  it('a null mint restores Firebase behaviour: a federated sign-in yields null', async () => {
    const auth = googleAuth();
    authSandbox.setAvatarMint(auth, () => null);
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com' }),
    );

    expect(cred.user.photoURL).toBeNull();
    expect(storedPhotoUrl(auth, 'ada')).toBeNull();
  });

  it('a host mint receives the record being created and its value is stored verbatim', async () => {
    const auth = googleAuth();
    const seen: Array<{ uid: string; displayName: string | null; email: string | null; providerId: string }> = [];
    authSandbox.setAvatarMint(auth, (input) => {
      seen.push(input);
      return `/avatars/${input.uid}`;
    });
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com', displayName: 'Ada' }),
    );

    expect(seen).toEqual([
      { uid: 'ada', displayName: 'Ada', email: 'ada@example.com', providerId: PROVIDER_ID },
    ]);
    expect(cred.user.photoURL).toBe('/avatars/ada');
    expect(storedPhotoUrl(auth, 'ada')).toBe('/avatars/ada');
  });

  it('an OIDC provider id counts as federated; a phone identity does not', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'oidc', email: 'oidc@example.com', password: 'pw', providerId: 'oidc.acme' },
      { uid: 'phone', email: 'phone@example.com', password: 'pw', providerId: 'phone' },
    ]);

    expect(storedPhotoUrl(auth, 'oidc')).toBe(
      defaultAvatarDataUri({ uid: 'oidc', displayName: null, email: 'oidc@example.com' }),
    );
    expect(storedPhotoUrl(auth, 'phone')).toBeNull();
  });
});
