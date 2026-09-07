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
 * Nothing here assigns a photo: every value under test is supplied by the
 * identity, exactly as a real OAuth provider supplies one.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  GoogleAuthProvider,
  getAuth,
  sandbox as authSandbox,
  signInWithPopup,
  type Auth,
  type AuthFlowResolver,
  type SignInIdentitySpec,
  type User,
} from '../../src/auth/index.js';

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

  it('picker mint without a photo leaves user.photoURL and providerData null', async () => {
    const auth = googleAuth();
    const cred = await signInWithPopup(
      auth,
      new GoogleAuthProvider(),
      pickerResolver(auth, { uid: 'ada', email: 'ada@example.com' }),
    );

    expect(cred.user.photoURL).toBeNull();
    expect(
      cred.user.providerData?.find((entry) => entry.providerId === PROVIDER_ID)?.photoURL,
    ).toBeNull();
    expect(storedPhotoUrl(auth, 'ada')).toBeNull();
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
