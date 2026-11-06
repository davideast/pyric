/**
 * A new Google identity from the account picker gets a verified email.
 *
 * Google's ID token asserts `email_verified` for the account's address, so
 * Firebase Auth returns `emailVerified: true` on the user, `email_verified:
 * true` on the ID token and `firebase.sign_in_provider: 'google.com'`, and
 * Security Rules read the same claim on `request.auth.token`. The picker lets
 * a developer type any address for a Google account, so a typed address is
 * verified too. An existing password or other-provider account keeps its own
 * flag: Firebase trusts Google for account linking only on `@gmail.com`, and
 * there it removes the unverified password, which the sandbox does not do.
 * A staged sign-in result keeps the caller's flag. Other federated providers
 * keep the account's own flag.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import {
  getAuth,
  sandbox as authSandbox,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  GoogleAuthProvider,
  type Auth,
  type AuthFlowResolver,
  type SignInIdentitySpec,
  type User,
} from '../../src/auth/index.js';
import type { Sandbox } from '../../src/sandbox/index.js';

const EMAIL = 'ada@example.com';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /allowlist/{email} {
      allow read: if request.auth.token.email_verified == true
        && request.auth.token.email == email;
    }
  }
}`;

function providerAuth(sandbox: Sandbox, providerId: string): Auth {
  const auth = getAuth(sandbox);
  authSandbox.setAuthProviderConfig(auth, providerId, true);
  return auth;
}

function storedEmailVerified(auth: Auth, uid: string): boolean | undefined {
  return authSandbox.listUsers(auth).find((user) => user.uid === uid)?.emailVerified;
}

/** The picker's "add account" mint, as the served in-page fallback wires it. */
function typedResolver(auth: Auth, providerId: string, spec: SignInIdentitySpec): AuthFlowResolver {
  const mint = async () => authSandbox.createSignInCredential(auth, { providerId, spec });
  return { openPopup: mint, openRedirect: mint };
}

describe('Google picker sign-in marks the email verified', () => {
  it('a typed address: user, stored record, and ID token all say verified', async () => {
    const auth = providerAuth(initializeSandbox(), 'google.com');
    const credential = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: EMAIL, displayName: 'Ada' },
    });
    expect(credential.user.emailVerified).toBe(true);
    expect(storedEmailVerified(auth, credential.user.uid)).toBe(true);
    const token = await credential.user.getIdTokenResult();
    expect(token.claims.email_verified).toBe(true);
  });

  it('a picked identity created unverified becomes verified', async () => {
    const auth = providerAuth(initializeSandbox(), 'google.com');
    const record = authSandbox.createUser(auth, { email: EMAIL });
    expect(record.emailVerified).toBe(false);
    const credential = authSandbox.createSignInCredential(auth, { providerId: 'google.com', uid: record.uid });
    expect(credential.user.emailVerified).toBe(true);
    expect(storedEmailVerified(auth, record.uid)).toBe(true);
    expect((await credential.user.getIdTokenResult()).claims.email_verified).toBe(true);
  });

  it('a non-Google provider keeps the account flag', async () => {
    const auth = providerAuth(initializeSandbox(), 'github.com');
    const credential = authSandbox.createSignInCredential(auth, {
      providerId: 'github.com',
      spec: { email: EMAIL },
    });
    expect(credential.user.emailVerified).toBe(false);
    expect((await credential.user.getIdTokenResult()).claims.email_verified).toBe(false);
  });

  it('Firestore rules requiring email_verified allow the Google user', async () => {
    const sandbox = initializeSandbox();
    const auth = providerAuth(sandbox, 'google.com');
    authSandbox.setAuthFlowResolver(auth, typedResolver(auth, 'google.com', { email: EMAIL }));
    const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(user.emailVerified).toBe(true);
    expect(auth.currentUser?.emailVerified).toBe(true);
    const token = await user.getIdTokenResult();
    expect(token.claims.email_verified).toBe(true);
    expect(token.signInProvider).toBe('google.com');
    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    getAdminFirestore(sandbox.withAuth(null)).setRules(FIRESTORE_RULES);
    const snapshot = await getDoc(doc(getFirestore(sandbox), 'allowlist', EMAIL));
    expect(snapshot.exists()).toBe(false);
  });
});

describe('an existing account keeps its own flag on a Google sign-in', () => {
  it('an unverified password account stays unverified, and its password still signs in', async () => {
    const auth = providerAuth(initializeSandbox(), 'google.com');
    const victim = 'victim@gmail.com';
    const created = await createUserWithEmailAndPassword(auth, victim, 'secret-pw');
    await signOut(auth);
    authSandbox.setAuthFlowResolver(auth, typedResolver(auth, 'google.com', { email: victim }));
    const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
    expect(user.uid).toBe(created.user.uid);
    expect(user.emailVerified).toBe(false);
    expect((await user.getIdTokenResult()).claims.email_verified).toBe(false);
    expect(authSandbox.listUsers(auth).find((record) => record.uid === user.uid)?.providerUserInfo.map((p) => p.providerId))
      .toEqual(['password', 'google.com']);
    await signOut(auth);
    const again = await signInWithEmailAndPassword(auth, victim, 'secret-pw');
    expect(again.user.emailVerified).toBe(false);
    expect((await again.user.getIdTokenResult()).claims.email_verified).toBe(false);
  });

  it('a GitHub account followed by a typed Google address stays unverified', async () => {
    const auth = providerAuth(initializeSandbox(), 'google.com');
    authSandbox.setAuthProviderConfig(auth, 'github.com', true);
    const github = authSandbox.createSignInCredential(auth, { providerId: 'github.com', spec: { email: EMAIL } });
    const google = authSandbox.createSignInCredential(auth, { providerId: 'google.com', spec: { email: EMAIL } });
    expect(google.user.uid).toBe(github.user.uid);
    expect(google.user.emailVerified).toBe(false);
    expect(storedEmailVerified(auth, github.user.uid)).toBe(false);
    expect((await google.user.getIdTokenResult()).claims.email_verified).toBe(false);
  });
});

/** A staged user as a test hands it to `mockSignInResult`. */
function stagedUser(emailVerified: boolean): User {
  const now = new Date().toISOString();
  return {
    uid: 'staged-ada',
    email: EMAIL,
    displayName: null,
    photoURL: null,
    isAnonymous: false,
    emailVerified,
    getIdToken: async () => 'staged-token',
    getIdTokenResult: async () => ({ token: 'staged-token', claims: {}, expirationTime: now, issuedAtTime: now, authTime: now }),
  };
}

describe('a staged Google result keeps the caller flag in-page', () => {
  for (const emailVerified of [false, true]) {
    it(`emailVerified: ${emailVerified} on the user and the token`, async () => {
      const auth = providerAuth(initializeSandbox(), 'google.com');
      authSandbox.mockSignInResult(auth, { user: stagedUser(emailVerified), providerId: 'google.com', operationType: 'signIn' });
      const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
      expect(user.emailVerified).toBe(emailVerified);
      expect(storedEmailVerified(auth, 'staged-ada')).toBe(emailVerified);
      const fresh = await auth.currentUser!.getIdTokenResult(true);
      expect(fresh.claims.email_verified).toBe(emailVerified);
    });
  }
});
