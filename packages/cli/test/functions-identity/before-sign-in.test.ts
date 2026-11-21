import { describe, expect, test } from 'bun:test';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  sandbox as authSandbox,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
} from 'pyric/auth';
import {
  makeAuthBlockingRejectionError,
  mintCustomTokenFor,
  setAuthBlockingHooks,
} from 'pyric/auth/internal';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { makeTestOidcJwt } from './hosted-harness.js';

describe('beforeUserSignedIn lifecycle, sessionClaims isolation, and rejection parity', () => {
  test('invokes beforeSignIn across all in-process sign-in methods and chains after beforeCreate', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    const trace: string[] = [];
    setAuthBlockingHooks(auth, {
      async beforeCreate(input) {
        trace.push(`create:${input.signInMethod}:${input.userRecord.uid}`);
        return {
          displayName: `Created:${input.signInMethod}`,
          customClaims: { createdMethod: input.signInMethod },
        };
      },
      async beforeSignIn(input) {
        trace.push(
          `signin:${input.signInMethod}:${input.userRecord.displayName ?? 'none'}:${String(input.userRecord.customClaims?.createdMethod ?? 'existing')}`,
        );
        return {
          sessionClaims: { activeMethod: input.signInMethod },
        };
      },
    });

    // 1. First-time createUserWithEmailAndPassword chains beforeCreate -> beforeSignIn,
    //    and beforeSignIn observes beforeCreate's displayName and customClaims on event.data.
    const createdPw = await createUserWithEmailAndPassword(auth, 'ada@chain.test', 'secret123');
    expect(createdPw.user.displayName).toBe('Created:password');
    const createdToken = await createdPw.user.getIdTokenResult();
    expect(createdToken.claims.createdMethod).toBe('password');
    expect(createdToken.claims.activeMethod).toBe('password');
    await auth.signOut();

    // 2. Existing signInWithEmailAndPassword invokes beforeSignIn only.
    const signedPw = await signInWithEmailAndPassword(auth, 'ada@chain.test', 'secret123');
    expect((await signedPw.user.getIdTokenResult()).claims.activeMethod).toBe('password');
    await auth.signOut();

    // 3. Existing EmailAuthCredential password signInWithCredential invokes beforeSignIn.
    const emailCred = await signInWithCredential(
      auth,
      EmailAuthProvider.credential('ada@chain.test', 'secret123'),
    );
    expect((await emailCred.user.getIdTokenResult()).claims.activeMethod).toBe('password');
    await auth.signOut();

    // 4. First-time signInAnonymously chains beforeCreate -> beforeSignIn.
    const anonCred = await signInAnonymously(auth);
    expect((await anonCred.user.getIdTokenResult()).claims.activeMethod).toBe('anonymous');
    await auth.signOut();

    // 5. OIDC signInWithCredential chains on new user and runs beforeSignIn on existing user.
    const jwt = makeTestOidcJwt({ sub: 'oidc-chain-1', email: 'grace@chain.test' });
    const oidcNew = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(jwt, 'access-new'),
    );
    expect((await oidcNew.user.getIdTokenResult()).claims.activeMethod).toBe('google.com');
    await auth.signOut();

    const oidcExisting = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(jwt, 'access-existing'),
    );
    expect((await oidcExisting.user.getIdTokenResult()).claims.activeMethod).toBe('google.com');
    await auth.signOut();

    // 6. Popup and Redirect sign-in on existing user invoke beforeSignIn.
    const popupResolver = {
      async openPopup() {
        return {
          user: oidcExisting.user,
          providerId: 'google.com',
          operationType: 'signIn' as const,
        };
      },
      async openRedirect() {
        return {
          user: oidcExisting.user,
          providerId: 'google.com',
          operationType: 'signIn' as const,
        };
      },
    };
    const popupRes = await signInWithPopup(auth, new GoogleAuthProvider(), popupResolver);
    expect((await popupRes.user.getIdTokenResult()).claims.activeMethod).toBe('google.com');
    await auth.signOut();

    await signInWithRedirect(auth, new GoogleAuthProvider(), popupResolver);
    const redirectRes = await getRedirectResult(auth);
    expect((await redirectRes?.user.getIdTokenResult())?.claims.activeMethod).toBe('google.com');
    await auth.signOut();

    // 7. Email-link sign-in on existing user runs beforeSignIn with emailLink method.
    await sendSignInLinkToEmail(auth, 'ada@chain.test', {
      url: 'https://example.com/finish',
      handleCodeInApp: true,
    });
    const mail = authSandbox.takeAuthMail(auth, 'ada@chain.test');
    if (!mail) throw new Error('expected sign-in email');
    const linkRes = await signInWithEmailLink(auth, 'ada@chain.test', mail.link);
    expect((await linkRes.user.getIdTokenResult()).claims.activeMethod).toBe('emailLink');
    await auth.signOut();

    // 8. Custom token sign-in on new and existing user runs beforeSignIn with custom method.
    const customTok1 = mintCustomTokenFor(auth, 'custom-chain-1', { devFlag: 'v1' });
    const customNew = await signInWithCustomToken(auth, customTok1);
    expect((await customNew.user.getIdTokenResult()).claims.activeMethod).toBe('custom');
    expect((await customNew.user.getIdTokenResult()).claims.devFlag).toBe('v1');
    await auth.signOut();

    const customTok2 = mintCustomTokenFor(auth, 'custom-chain-1', { devFlag: 'v2' });
    const customExisting = await signInWithCustomToken(auth, customTok2);
    expect((await customExisting.user.getIdTokenResult()).claims.activeMethod).toBe('custom');
    expect((await customExisting.user.getIdTokenResult()).claims.devFlag).toBe('v2');
    await auth.signOut();

    expect(trace).toEqual([
      `create:password:${createdPw.user.uid}`,
      'signin:password:Created:password:password',
      'signin:password:Created:password:password',
      'signin:password:Created:password:password',
      `create:anonymous:${anonCred.user.uid}`,
      'signin:anonymous:Created:anonymous:anonymous',
      'create:google.com:oidc-chain-1',
      'signin:google.com:Created:google.com:google.com',
      'signin:google.com:Created:google.com:google.com',
      'signin:google.com:Created:google.com:google.com',
      'signin:google.com:Created:google.com:google.com',
      'signin:emailLink:Created:password:password',
      'create:custom:custom-chain-1',
      'signin:custom:Created:custom:custom',
      'signin:custom:Created:custom:custom',
    ]);
  });

  test('persists BeforeSignInResponse user mutations while keeping sessionClaims transient across refreshes, Rules, and Admin SDK', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const db = getFirestore(sandbox);
    const adminApp = initializeAdminApp(
      { sandbox, projectId: 'pyric-sandbox' },
      'admin-signin-test-1',
    );
    const adminAuth = getAdminAuth(adminApp);

    setFirestoreRules(
      sandbox,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /stepUpDocs/{id} {',
        "      allow read, write: if request.auth != null && request.auth.token.role == 'member' && request.auth.token.stepUp == true;",
        '    }',
        '    match /memberDocs/{id} {',
        "      allow read, write: if request.auth != null && request.auth.token.role == 'member';",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );

    authSandbox.createUser(auth, {
      uid: 'u-session-1',
      email: 'session@example.com',
      password: 'secret123',
      displayName: 'Initial Name',
      photoUrl: 'https://img.example.com/old.png',
      emailVerified: false,
    });

    let loginCount = 0;
    setAuthBlockingHooks(auth, {
      async beforeSignIn() {
        loginCount += 1;
        if (loginCount === 1) {
          return {
            displayName: 'Mutated Name',
            photoURL: '',
            emailVerified: true,
            customClaims: { role: 'member' },
            sessionClaims: { stepUp: true, sessionTurn: 1 },
            recaptchaActionOverride: 'ALLOW',
          };
        }
        return {};
      },
    });

    // Sign-in #1: returns both customClaims and sessionClaims, plus clears photoURL to null.
    const first = await signInWithEmailAndPassword(auth, 'session@example.com', 'secret123');
    expect(first.user.displayName).toBe('Mutated Name');
    expect(first.user.photoURL).toBeNull();
    expect(first.user.emailVerified).toBe(true);

    const initialToken = await first.user.getIdTokenResult(false);
    expect(initialToken.claims.role).toBe('member');
    expect(initialToken.claims.stepUp).toBe(true);
    expect(initialToken.claims.sessionTurn).toBe(1);

    // Forced refresh inside the same session retains sessionClaims.
    const refreshedToken = await first.user.getIdTokenResult(true);
    expect(refreshedToken.token).not.toBe(initialToken.token);
    expect(refreshedToken.claims.role).toBe('member');
    expect(refreshedToken.claims.stepUp).toBe(true);
    expect(refreshedToken.claims.sessionTurn).toBe(1);

    // Admin verifyIdToken sees sessionClaims, while getUser().customClaims has only persistent customClaims.
    const decoded = await adminAuth.verifyIdToken(refreshedToken.token);
    expect(decoded.role).toBe('member');
    expect(decoded.stepUp).toBe(true);
    const adminRecord = await adminAuth.getUser('u-session-1');
    expect(adminRecord.customClaims).toEqual({ role: 'member' });

    // Firestore Rules see sessionClaims on request.auth.token.
    await setDoc(doc(db, 'stepUpDocs/d1'), { ok: true });
    expect((await getDoc(doc(db, 'stepUpDocs/d1'))).data()).toEqual({ ok: true });
    await auth.signOut();

    // Sign-in #2: beforeSignIn returns {}, so persistent role: 'member' stays while sessionClaims are gone.
    const second = await signInWithEmailAndPassword(auth, 'session@example.com', 'secret123');
    const secondInitial = await second.user.getIdTokenResult(false);
    const secondRefreshed = await second.user.getIdTokenResult(true);
    expect(secondInitial.claims.role).toBe('member');
    expect(secondInitial.claims.stepUp).toBeUndefined();
    expect(secondInitial.claims.sessionTurn).toBeUndefined();
    expect(secondRefreshed.claims.role).toBe('member');
    expect(secondRefreshed.claims.stepUp).toBeUndefined();

    // Step-up collection is now denied by Rules, while persistent member collection stays allowed.
    let rulesErr: (Error & { code?: string }) | undefined;
    try {
      await setDoc(doc(db, 'stepUpDocs/d2'), { ok: false });
    } catch (err) {
      rulesErr = err as Error & { code?: string };
    }
    expect(rulesErr?.code).toBe('permission-denied');
    await setDoc(doc(db, 'memberDocs/m1'), { ok: true });
    expect((await getDoc(doc(db, 'memberDocs/m1'))).data()).toEqual({ ok: true });
    await deleteAdminApp(adminApp);
  });

  test('persists disabled: true from beforeSignIn and rejects sign-in with auth/user-disabled', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.createUser(auth, {
      uid: 'u-disable-signin',
      email: 'ban@example.com',
      password: 'secret123',
      disabled: false,
    });

    setAuthBlockingHooks(auth, {
      async beforeSignIn() {
        return {
          displayName: 'Suspended On SignIn',
          disabled: true,
        };
      },
    });

    let caught: (Error & { code?: string }) | undefined;
    try {
      await signInWithEmailAndPassword(auth, 'ban@example.com', 'secret123');
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught?.code).toBe('auth/user-disabled');
    expect(auth.currentUser).toBeNull();

    const stored = authSandbox.listUsers(auth).find((u) => u.uid === 'u-disable-signin');
    expect(stored?.disabled).toBe(true);
    expect(stored?.displayName).toBe('Suspended On SignIn');
  });

  test('rejects on HttpsError, reserved claims, and >1000-char combined claims without mutating existing user or issuing session', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const adminApp = initializeAdminApp(
      { sandbox, projectId: 'pyric-sandbox' },
      'admin-signin-test-2',
    );
    const adminAuth = getAdminAuth(adminApp);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.createUser(auth, {
      uid: 'u-existing-safe',
      email: 'safe@example.com',
      password: 'secret123',
      displayName: 'Original Safe Name',
      emailVerified: false,
      customClaims: { base: 'intact' },
    });
    await adminAuth.revokeRefreshTokens('u-existing-safe');

    let mode: 'deny' | 'reserved-session' | 'oversized-combined' | 'deny-after-create' = 'deny';
    let seenTokensValidAfter: number | null | undefined;

    setAuthBlockingHooks(auth, {
      async beforeCreate() {
        return { displayName: 'Created Before SignIn Block' };
      },
      async beforeSignIn(input) {
        seenTokensValidAfter = input.userRecord.tokensValidAfterSeconds;
        if (mode === 'deny' || mode === 'deny-after-create') {
          throw makeAuthBlockingRejectionError({
            status: 'PERMISSION_DENIED',
            message: 'Sign-in blocked by policy',
          });
        }
        if (mode === 'reserved-session') {
          return { sessionClaims: { sub: 'illegal-sub' } };
        }
        return {
          customClaims: { a: 'x'.repeat(550) },
          sessionClaims: { b: 'y'.repeat(550) },
        };
      },
    });

    // OIDC sign-in on existing user with different displayName/emailVerified must NOT mutate stored user on rejection.
    const jwt = makeTestOidcJwt({
      sub: 'u-existing-safe',
      email: 'safe@example.com',
      name: 'Should Not Persist',
      email_verified: true,
    });
    let denyErr: (Error & { code?: string }) | undefined;
    try {
      await signInWithCredential(auth, GoogleAuthProvider.credential(jwt, 'tok-1'));
    } catch (err) {
      denyErr = err as Error & { code?: string };
    }
    expect(denyErr?.code).toBe('auth/internal-error');
    expect(denyErr?.message).toContain('PERMISSION_DENIED');
    expect(typeof seenTokensValidAfter).toBe('number');
    expect(auth.currentUser).toBeNull();

    const afterDeny = authSandbox.listUsers(auth).find((u) => u.uid === 'u-existing-safe');
    expect(afterDeny?.displayName).toBe('Original Safe Name');
    expect(afterDeny?.emailVerified).toBe(false);
    expect(afterDeny?.customClaims).toEqual({ base: 'intact' });

    // Reserved sessionClaims rejected with INVALID_ARGUMENT.
    mode = 'reserved-session';
    let reservedErr: (Error & { code?: string }) | undefined;
    try {
      await signInWithEmailAndPassword(auth, 'safe@example.com', 'secret123');
    } catch (err) {
      reservedErr = err as Error & { code?: string };
    }
    expect(reservedErr?.code).toBe('auth/internal-error');
    expect(reservedErr?.message).toContain('INVALID_ARGUMENT');
    expect(auth.currentUser).toBeNull();

    // Combined customClaims + sessionClaims > 1000 chars rejected before mutating customClaims.
    mode = 'oversized-combined';
    let oversizedErr: (Error & { code?: string }) | undefined;
    try {
      await signInWithEmailAndPassword(auth, 'safe@example.com', 'secret123');
    } catch (err) {
      oversizedErr = err as Error & { code?: string };
    }
    expect(oversizedErr?.code).toBe('auth/internal-error');
    expect(oversizedErr?.message).toContain('should not exceed 1000 characters combined');
    expect(auth.currentUser).toBeNull();
    expect(
      authSandbox.listUsers(auth).find((u) => u.uid === 'u-existing-safe')?.customClaims,
    ).toEqual({ base: 'intact' });

    // First-time sign-up where beforeCreate succeeds and beforeSignIn throws issues zero session.
    mode = 'deny-after-create';
    let chainErr: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(auth, 'newuser@example.com', 'secret123');
    } catch (err) {
      chainErr = err as Error & { code?: string };
    }
    expect(chainErr?.code).toBe('auth/internal-error');
    expect(auth.currentUser).toBeNull();
    await deleteAdminApp(adminApp);
  });
});
