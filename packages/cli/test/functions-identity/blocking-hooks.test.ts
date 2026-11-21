import { describe, expect, test } from 'bun:test';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailLink,
  signInWithPopup,
} from 'pyric/auth';
import {
  makeAuthBlockingRejectionError,
  mintCustomTokenFor,
  setAuthBlockingHooks,
} from 'pyric/auth/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { makeTestOidcJwt } from './hosted-harness.js';

describe('in-process pyric/auth blocking-hook seam and transient sessionClaims support', () => {
  test('applies BeforeCreateResponse across in-process registration flows and bypasses sandbox.createUser', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    const seenMethods: string[] = [];
    setAuthBlockingHooks(auth, {
      async beforeCreate(input) {
        seenMethods.push(input.signInMethod);
        if (input.userRecord.email?.endsWith('@reject.test')) {
          throw makeAuthBlockingRejectionError({
            status: 'PERMISSION_DENIED',
            message: 'Blocked in-process sign-up',
          });
        }
        return {
          displayName: `Hooked:${input.signInMethod}`,
          emailVerified: true,
          customClaims: { createdVia: input.signInMethod },
        };
      },
    });

    // Rejected sign-up persists nothing.
    let denied: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(auth, 'nope@reject.test', 'secret123');
    } catch (err) {
      denied = err as Error & { code?: string };
    }
    expect(denied?.code).toBe('auth/internal-error');
    expect(denied?.message).toContain('PERMISSION_DENIED');
    expect(authSandbox.listUsers(auth)).toEqual([]);

    // Email/password creation.
    const pwCred = await createUserWithEmailAndPassword(auth, 'ada@ok.test', 'secret123');
    expect(pwCred.user.displayName).toBe('Hooked:password');
    expect(pwCred.user.emailVerified).toBe(true);
    expect((await pwCred.user.getIdTokenResult()).claims.createdVia).toBe('password');
    await auth.signOut();

    // Anonymous creation.
    const anonCred = await signInAnonymously(auth);
    expect(anonCred.user.displayName).toBe('Hooked:anonymous');
    expect((await anonCred.user.getIdTokenResult()).claims.createdVia).toBe('anonymous');
    await auth.signOut();

    // OIDC JWT creation.
    const jwt = makeTestOidcJwt({ sub: 'inproc-google-1', email: 'grace@ok.test' });
    const oidcCred = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(jwt, 'access-1'),
    );
    expect(oidcCred.user.displayName).toBe('Hooked:google.com');
    expect((await oidcCred.user.getIdTokenResult()).claims.createdVia).toBe('google.com');
    await auth.signOut();

    // Popup creation with resolver.
    const popupCred = await signInWithPopup(auth, new GoogleAuthProvider(), {
      async openPopup() {
        return {
          user: {
            uid: 'popup-uid-1',
            email: 'popup@ok.test',
            emailVerified: false,
            displayName: 'Popup Raw',
            photoURL: null,
            phoneNumber: null,
            isAnonymous: false,
            tenantId: null,
            providerId: 'firebase',
            providerData: [],
            getIdToken: async () => '',
            getIdTokenResult: async () => ({
              token: '',
              claims: {},
              authTime: '',
              issuedAtTime: '',
              expirationTime: '',
              signInProvider: 'google.com',
              signInSecondFactor: null,
            }),
          },
          providerId: 'google.com',
          operationType: 'signIn',
        };
      },
      async openRedirect() {
        throw new Error('unused');
      },
    });
    expect(popupCred.user.displayName).toBe('Hooked:google.com');
    await auth.signOut();

    // Email-link first-time creation.
    await sendSignInLinkToEmail(auth, 'link@ok.test', {
      url: 'https://example.com/finish',
      handleCodeInApp: true,
    });
    const mail = authSandbox.takeAuthMail(auth, 'link@ok.test');
    if (!mail) throw new Error('expected mail');
    const linkCred = await signInWithEmailLink(auth, 'link@ok.test', mail.link);
    expect(linkCred.user.displayName).toBe('Hooked:emailLink');
    await auth.signOut();

    // Custom token first-time creation.
    const customTok = mintCustomTokenFor(auth, 'custom-inproc-1', { extra: true });
    const customCred = await signInWithCustomToken(auth, customTok);
    expect(customCred.user.displayName).toBe('Hooked:custom');
    await auth.signOut();

    // Admin sandbox.createUser bypasses beforeCreate even on @reject.test.
    const countBeforeAdmin = seenMethods.length;
    const adminUser = authSandbox.createUser(auth, {
      uid: 'admin-direct-1',
      email: 'admin@reject.test',
      password: 'secret123',
    });
    expect(adminUser.uid).toBe('admin-direct-1');
    expect(seenMethods.length).toBe(countBeforeAdmin);

    expect(seenMethods).toEqual([
      'password',
      'password',
      'anonymous',
      'google.com',
      'google.com',
      'emailLink',
      'custom',
    ]);
  });

  test('merges transient sessionClaims on mintSession without mutating persistent customClaims', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.createUser(auth, {
      uid: 'session-claims-u1',
      email: 'sc@example.com',
      password: 'secret123',
      customClaims: { persistentRole: 'editor' },
    });

    const firstSession = authSandbox.mintSession(auth, {
      kind: 'provider',
      uid: 'session-claims-u1',
      providerId: 'password',
      sessionClaims: { ephemeralFlag: 'turn-1' },
    });
    const firstToken = await firstSession.user.getIdTokenResult();
    expect(firstToken.claims.persistentRole).toBe('editor');
    expect(firstToken.claims.ephemeralFlag).toBe('turn-1');

    // Stored record retains only persistent customClaims.
    const stored = authSandbox.listUsers(auth).find((u) => u.uid === 'session-claims-u1');
    expect(stored?.customClaims).toEqual({ persistentRole: 'editor' });

    // Subsequent session without sessionClaims does NOT carry ephemeralFlag.
    const secondSession = authSandbox.mintSession(auth, {
      kind: 'provider',
      uid: 'session-claims-u1',
      providerId: 'password',
    });
    const secondToken = await secondSession.user.getIdTokenResult();
    expect(secondToken.claims.persistentRole).toBe('editor');
    expect(secondToken.claims.ephemeralFlag).toBeUndefined();
  });
});
