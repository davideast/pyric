/**
 * A Google sign-in through the account picker vouches for the account's email.
 *
 * Production marks a Google account's email verified: Firebase Auth returns
 * `emailVerified: true` on the user, `email_verified: true` on the ID token
 * and `firebase.sign_in_provider: 'google.com'`, and Security Rules read the
 * same claim on `request.auth.token`. The picker lets a developer type any
 * address, and a Google account's address is verified, so a typed address is
 * verified too. Other federated providers keep the account's own flag.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import {
  getAuth,
  sandbox as authSandbox,
  signInWithPopup,
  GoogleAuthProvider,
  type Auth,
  type AuthFlowResolver,
  type SignInIdentitySpec,
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
