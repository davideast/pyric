/**
 * Host-level fallback AuthFlowResolver, cross-backend User rebinding, and
 * defaultAvatarMint inheritance for served pages forced in-page (#1802).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { bindAppRegistrySandbox } from '../../src/app/internal.js';
import { defaultAvatarMint } from '../../src/auth/sandbox/default-avatar.js';
import { createSandboxRoot } from '../../src/sandbox/internal/root.js';
import {
  GoogleAuthProvider,
  GithubAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  linkWithPopup,
  linkWithRedirect,
  reauthenticateWithPopup,
  reauthenticateWithRedirect,
  sandbox as authSandbox,
  signInWithPopup,
  signInWithRedirect,
  type AuthFlowRequest,
  type AuthFlowResolver,
  type User,
} from '../../src/auth/index.js';

function makeStagedUser(uid: string, email: string): User {
  const now = new Date().toISOString();
  return {
    uid,
    email,
    displayName: 'Staged User',
    photoURL: null,
    isAnonymous: false,
    emailVerified: true,
    getIdToken: async () => 'staged-tok',
    getIdTokenResult: async () => ({
      token: 'staged-tok',
      claims: {},
      expirationTime: now,
      issuedAtTime: now,
      authTime: now,
    }),
  };
}

describe('in-page host AuthFlowResolver fallback (#1802)', () => {
  const sandbox = createSandboxRoot();
  bindAppRegistrySandbox(sandbox);
  const hostAuth = getAuth(sandbox);

  beforeEach(() => {
    authSandbox.clearUsers(hostAuth);
    authSandbox.setAuthFlowResolver(hostAuth, null);
    authSandbox.setAvatarMint(hostAuth, defaultAvatarMint);
    authSandbox.setAuthProviderConfig(hostAuth, 'google.com', true);
    authSandbox.setAuthProviderConfig(hostAuth, 'github.com', true);
  });

  afterEach(async () => {
    for (const app of [...getApps()]) {
      await deleteApp(app);
    }
  });

  it('signs in getAuth(app) through the resolver installed on getAuth(sandbox) and inherits avatarMint', async () => {
    authSandbox.setAvatarMint(
      hostAuth,
      ({ uid, providerId }) => `/__pyric/assets/avatar/${uid}?p=${providerId}`,
    );

    const seenRequests: AuthFlowRequest[] = [];
    const resolver: AuthFlowResolver = {
      openPopup: async (req) => {
        seenRequests.push(req);
        return authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'ada@example.com', displayName: 'Ada' },
        });
      },
      openRedirect: async (req) => {
        seenRequests.push(req);
        return authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'grace@example.com', displayName: 'Grace' },
        });
      },
    };
    authSandbox.setAuthFlowResolver(hostAuth, resolver);

    const app = initializeApp(
      { apiKey: 'demo', appId: 'demo', projectId: 'demo-app' },
      'inpage-popup-app',
    );
    const appAuth = getAuth(app);
    expect(appAuth === hostAuth).toBe(false);

    const popupCred = await signInWithPopup(appAuth, new GoogleAuthProvider());
    expect(seenRequests[0]).toEqual({ providerId: 'google.com', authType: 'signIn' });
    expect(popupCred.user.email).toBe('ada@example.com');
    expect(popupCred.user.emailVerified).toBe(true);
    expect(popupCred.user).toBe(appAuth.currentUser);
    expect(popupCred.user.photoURL).toBe(
      `/__pyric/assets/avatar/${popupCred.user.uid}?p=google.com`,
    );
    const tokenResult = await popupCred.user.getIdTokenResult();
    expect(tokenResult.signInProvider).toBe('google.com');
    expect(tokenResult.claims.email_verified).toBe(true);

    await signInWithRedirect(appAuth, new GoogleAuthProvider());
    expect(appAuth.currentUser?.email).toBe('grace@example.com');
  });

  it('honors per-call > per-app resolver > mockSignInResult > host fallback resolver precedence', async () => {
    const hostResolver: AuthFlowResolver = {
      openPopup: async (req) =>
        authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'from-host@example.com' },
        }),
      openRedirect: async (req) =>
        authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'from-host@example.com' },
        }),
    };
    authSandbox.setAuthFlowResolver(hostAuth, hostResolver);

    const app = initializeApp(
      { apiKey: 'demo', appId: 'demo', projectId: 'demo-app' },
      'inpage-precedence-app',
    );
    const appAuth = getAuth(app);

    // 1. Staged mockSignInResult on getAuth(app) wins over the host fallback resolver.
    authSandbox.mockSignInResult(appAuth, {
      user: makeStagedUser('staged-uid-1', 'staged@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });
    const stagedCred = await signInWithPopup(appAuth, new GoogleAuthProvider());
    expect(stagedCred.user.uid).toBe('staged-uid-1');

    // 2. Once the single-use mock is consumed, getAuth(app) falls back to hostResolver.
    const hostCred = await signInWithPopup(appAuth, new GoogleAuthProvider());
    expect(hostCred.user.email).toBe('from-host@example.com');

    // 3. Per-app setAuthFlowResolver overrides hostResolver, and per-call overrides per-app.
    const appResolver: AuthFlowResolver = {
      openPopup: async (req) =>
        authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'from-app@example.com' },
        }),
      openRedirect: async (req) =>
        authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'from-app@example.com' },
        }),
    };
    authSandbox.setAuthFlowResolver(appAuth, appResolver);
    const appCred = await signInWithPopup(appAuth, new GoogleAuthProvider());
    expect(appCred.user.email).toBe('from-app@example.com');

    const perCallResolver: AuthFlowResolver = {
      openPopup: async (req) =>
        authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'from-call@example.com' },
        }),
      openRedirect: async (req) =>
        authSandbox.createSignInCredential(hostAuth, {
          providerId: req.providerId,
          spec: { email: 'from-call@example.com' },
        }),
    };
    const callCred = await signInWithPopup(appAuth, new GoogleAuthProvider(), perCallResolver);
    expect(callCred.user.email).toBe('from-call@example.com');
  });

  it('supports linkWithPopup, linkWithRedirect, reauthenticateWithPopup, and reauthenticateWithRedirect via host fallback resolver', async () => {
    const app = initializeApp(
      { apiKey: 'demo', appId: 'demo', projectId: 'demo-app' },
      'inpage-link-reauth-app',
    );
    const appAuth = getAuth(app);
    const created = await createUserWithEmailAndPassword(appAuth, 'owner@example.com', 'secret123');

    authSandbox.setAuthFlowResolver(hostAuth, {
      openPopup: async (req) => ({
        user: makeStagedUser(created.user.uid, 'owner@example.com'),
        providerId: req.providerId,
        operationType: 'signIn',
      }),
      openRedirect: async (req) => ({
        user: makeStagedUser(created.user.uid, 'owner@example.com'),
        providerId: req.providerId,
        operationType: 'signIn',
      }),
    });

    const linkedPopup = await linkWithPopup(created.user, new GoogleAuthProvider());
    expect(linkedPopup.user.providerData?.map((p) => p.providerId)).toEqual([
      'password',
      'google.com',
    ]);

    const linkedRedirect = await linkWithRedirect(linkedPopup.user, new GithubAuthProvider());
    expect(linkedRedirect.user.providerData?.map((p) => p.providerId)).toEqual([
      'password',
      'google.com',
      'github.com',
    ]);

    const reauthedPopup = await reauthenticateWithPopup(linkedRedirect.user, new GoogleAuthProvider());
    expect(reauthedPopup.operationType).toBe('reauthenticate');

    const reauthedRedirect = await reauthenticateWithRedirect(
      reauthedPopup.user,
      new GithubAuthProvider(),
    );
    expect(reauthedRedirect.operationType).toBe('reauthenticate');
  });
});
