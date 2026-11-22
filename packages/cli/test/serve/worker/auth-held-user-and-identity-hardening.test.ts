/**
 * Regression suite for:
 * - #1948: Worker-plane Auth ops act on the held `User` handle (its own uid,
 *   tenantId, and sessionKey) after switching accounts or signing out, matching
 *   `@firebase/auth` and in-page Pyric.
 * - #1491: Served `auth.acceptIdentity` and `auth.mockSignInResult` reject empty
 *   or whitespace `uid` values and look-alike / unsupported `providerId` values
 *   at the shared validation boundary and seeder seam.
 */

import { describe, expect, it } from 'bun:test';
import {
  EmailAuthProvider,
  getAuth as getInPageAuth,
  sandbox as authSandbox,
} from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { handleMessage, cleanupPort, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { portSession } from '../../../src/serve/worker/host-auth.js';
import { resolveOAuthCredentialUser } from '../../../src/serve/worker/host/auth-session-seeder.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SerializedUser,
} from '../../../src/serve/worker/protocol.js';
import {
  clientUserSessionKey,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth as getClientAuth,
  linkWithCredential,
  onAuthStateChanged,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  stageSignInResult,
  updateCurrentUser,
  updateEmail,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
  type ClientAuth,
  type ClientDb,
} from '../../../src/serve/worker/client.js';

interface Harness {
  readonly sandbox: ReturnType<typeof initializeSandbox>;
  readonly ctx: HostCtx;
  readonly hostPort: PortLike;
  readonly clientAuth: ClientAuth;
  readonly rawPort: PortLike;
  sendRaw(fields: Record<string, unknown>): Promise<ResMessage>;
  dispose(): void;
}

function createHarness(): Harness {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    subs: new Map(),
    sessionMode: 'LOCAL',
    flushPersistence: async () => {},
  };

  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) {
      void handleMessage(ctx, hostPort, message);
    },
    start() {},
  };
  const hostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      clientPort.onmessage?.({ data: message } as MessageEvent<OutboundMessage>);
    },
  };
  wirePort(clientPort);
  const clientAuth = getClientAuth({ __kind: 'client-db', port: clientPort } as ClientDb);

  const rawMessages: OutboundMessage[] = [];
  const rawPort: PortLike = {
    postMessage(message: OutboundMessage) {
      rawMessages.push(message);
    },
  };

  async function sendRaw(fields: Record<string, unknown>): Promise<ResMessage> {
    const id = crypto.randomUUID();
    await handleMessage(ctx, rawPort, { t: 'op', id, ...fields } as InboundMessage);
    const reply = rawMessages.find((entry): entry is ResMessage => entry.t === 'res' && entry.id === id);
    if (reply === undefined) {
      throw new Error('No response from host');
    }
    return reply;
  }

  return {
    sandbox,
    ctx,
    hostPort,
    clientAuth,
    rawPort,
    sendRaw,
    dispose() {
      cleanupPort(ctx, hostPort);
      cleanupPort(ctx, rawPort);
    },
  };
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    return code;
  }
  return String(error);
}

async function expectRejectionCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(errorCodeOf(caught)).toBe(expectedCode);
}

describe('worker-plane held User fidelity (#1948)', () => {
  it('acts on held userA across getIdToken, updateProfile, reload, email/password updates, verification mail, reauth, and deleteUser while userB is signed in', async () => {
    const h = createHarness();
    try {
      const inPageAuth = getInPageAuth(h.sandbox);
      const credA = await createUserWithEmailAndPassword(h.clientAuth, 'alice@example.com', 'alice-pass-1');
      const userA = credA.user;
      const credB = await createUserWithEmailAndPassword(h.clientAuth, 'bob@example.com', 'bob-pass-1');
      const userB = credB.user;

      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);

      const authEvents: Array<string | null> = [];
      const tokenEvents: Array<string | null> = [];
      const stopAuth = onAuthStateChanged(h.clientAuth, (u) => authEvents.push(u?.uid ?? null));
      const stopToken = onIdTokenChanged(h.clientAuth, (u) => tokenEvents.push(u?.uid ?? null));
      await new Promise((resolve) => setTimeout(resolve, 10));
      authEvents.length = 0;
      tokenEvents.length = 0;

      // Token reads on held userA return userA's own token without touching userB or listeners.
      const tokenA = await userA.getIdTokenResult(false);
      const tokenB = await userB.getIdTokenResult(false);
      expect(tokenA.claims.user_id).toBe(userA.uid);
      expect(tokenA.claims.email).toBe('alice@example.com');
      expect(tokenB.claims.user_id).toBe(userB.uid);
      expect(await userA.getIdToken(false)).toBe(tokenA.token);

      // Forced refresh on held userA picks up userA's updated custom claims without notifying port listeners.
      authSandbox.updateUser(inPageAuth, userA.uid, { customClaims: { tier: 'gold' } });
      const cachedA = await userA.getIdTokenResult(false);
      expect(cachedA.claims.tier).toBeUndefined();
      const refreshedA = await userA.getIdTokenResult(true);
      expect(refreshedA.claims.user_id).toBe(userA.uid);
      expect(refreshedA.claims.tier).toBe('gold');
      expect((await userB.getIdTokenResult(true)).claims.tier).toBeUndefined();
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      expect(authEvents).toEqual([]);
      // Only userB's forced refresh fires onIdTokenChanged (not userA's).
      expect(tokenEvents).toEqual([userB.uid]);
      tokenEvents.length = 0;

      // updateProfile(userA) mutates only userA.
      await updateProfile(userA, { displayName: 'Alice Updated', photoURL: 'https://example.com/alice.png' });
      expect(userA.displayName).toBe('Alice Updated');
      expect(userA.photoURL).toBe('https://example.com/alice.png');
      expect(userB.displayName).toBeNull();
      const storedAfterProfile = authSandbox.listUsers(inPageAuth);
      expect(storedAfterProfile.find((u) => u.uid === userA.uid)?.displayName).toBe('Alice Updated');
      expect(storedAfterProfile.find((u) => u.uid === userB.uid)?.displayName).toBeNull();

      // reload(userA) refreshes userA from store without firing port idToken listeners.
      authSandbox.updateUser(inPageAuth, userA.uid, { displayName: 'Alice Reloaded' });
      await reload(userA);
      expect(userA.displayName).toBe('Alice Reloaded');
      expect(userB.displayName).toBeNull();
      expect(tokenEvents).toEqual([]);

      // updateEmail(userA) and updatePassword(userA) mutate only userA.
      await updateEmail(userA, 'alice-new@example.com');
      expect(userA.email).toBe('alice-new@example.com');
      expect(userB.email).toBe('bob@example.com');
      await updatePassword(userA, 'alice-pass-2');
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      expect((await userA.getIdTokenResult(true)).claims.email).toBe('alice-new@example.com');

      // Verification email helpers and reauthentication on held userA act on userA.
      await sendEmailVerification(userA);
      const verifyMail = authSandbox.takeAuthMail(inPageAuth, 'alice-new@example.com');
      expect(verifyMail?.operation).toBe('VERIFY_EMAIL');
      await verifyBeforeUpdateEmail(userA, 'alice-pending@example.com');
      const changeMail = authSandbox.takeAuthMail(inPageAuth, 'alice-pending@example.com');
      expect(changeMail?.operation).toBe('VERIFY_AND_CHANGE_EMAIL');
      const sessionKeyBeforeReauth = clientUserSessionKey(userA);
      const reauth = await reauthenticateWithCredential(
        userA,
        EmailAuthProvider.credential('alice-new@example.com', 'alice-pass-2'),
      );
      expect(reauth.user.uid).toBe(userA.uid);
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      const sessionKeyAfterReauth = clientUserSessionKey(userA);
      expect(sessionKeyAfterReauth).toBeDefined();
      expect(sessionKeyAfterReauth).not.toBe(sessionKeyBeforeReauth);
      expect(Object.hasOwn(userA, 'sessionKey')).toBe(false);
      // Verify the updated non-enumerable sessionKey works on updateCurrentUser and returns cleanly to userB.
      await updateCurrentUser(h.clientAuth, userA);
      expect(h.clientAuth.currentUser?.uid).toBe(userA.uid);
      expect((await userA.getIdTokenResult(true)).claims.user_id).toBe(userA.uid);
      await updateCurrentUser(h.clientAuth, userB);
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      await new Promise((resolve) => setTimeout(resolve, 10));
      authEvents.length = 0;
      tokenEvents.length = 0;

      // Disabling userA rejects userA ops without signing out userB.
      authSandbox.updateUser(inPageAuth, userA.uid, { disabled: true });
      await expectRejectionCode(userA.getIdToken(true), 'auth/user-disabled');
      await expectRejectionCode(reload(userA), 'auth/user-disabled');
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      expect(portSession(h.ctx, h.hostPort)?.user.uid).toBe(userB.uid);
      authSandbox.updateUser(inPageAuth, userA.uid, { disabled: false });

      // deleteUser(userA) removes only userA and leaves userB signed in.
      await deleteUser(userA);
      const storedAfterDelete = authSandbox.listUsers(inPageAuth);
      expect(storedAfterDelete.some((u) => u.uid === userA.uid)).toBe(false);
      expect(storedAfterDelete.some((u) => u.uid === userB.uid)).toBe(true);
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      expect(portSession(h.ctx, h.hostPort)?.user.uid).toBe(userB.uid);
      expect(authEvents).toEqual([]);

      // Reloading deleted userA rejects auth/user-token-expired without signing out userB.
      await expectRejectionCode(reload(userA), 'auth/user-token-expired');
      expect(h.clientAuth.currentUser?.uid).toBe(userB.uid);
      expect(portSession(h.ctx, h.hostPort)?.user.uid).toBe(userB.uid);

      stopAuth();
      stopToken();
    } finally {
      h.dispose();
    }
  });

  it('acts on held userA after signOut without rejecting auth/no-current-user', async () => {
    const h = createHarness();
    try {
      const inPageAuth = getInPageAuth(h.sandbox);
      const { user: userA } = await createUserWithEmailAndPassword(h.clientAuth, 'solo@example.com', 'secret-1');
      await signOut(h.clientAuth);
      expect(h.clientAuth.currentUser).toBeNull();
      expect(portSession(h.ctx, h.hostPort)).toBeNull();

      const tokenResult = await userA.getIdTokenResult(false);
      expect(tokenResult.claims.user_id).toBe(userA.uid);
      expect(await userA.getIdToken(true)).toBeTruthy();

      await updateProfile(userA, { displayName: 'Solo Updated' });
      expect(userA.displayName).toBe('Solo Updated');
      expect(authSandbox.listUsers(inPageAuth).find((u) => u.uid === userA.uid)?.displayName).toBe('Solo Updated');

      authSandbox.updateUser(inPageAuth, userA.uid, { displayName: 'Solo Reloaded' });
      await reload(userA);
      expect(userA.displayName).toBe('Solo Reloaded');

      await updateEmail(userA, 'solo-2@example.com');
      await updatePassword(userA, 'secret-2');
      expect(h.clientAuth.currentUser).toBeNull();

      await deleteUser(userA);
      expect(authSandbox.listUsers(inPageAuth).some((u) => u.uid === userA.uid)).toBe(false);
      expect(h.clientAuth.currentUser).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('evaluates revocation against the held user sessionKey and isolates tenants', async () => {
    const h = createHarness();
    try {
      const clock = getClock(h.sandbox);
      const inPageAuth = getInPageAuth(h.sandbox);
      clock.set(Date.UTC(2026, 6, 1, 12, 0, 0));

      const first = await createUserWithEmailAndPassword(h.clientAuth, 'rev@example.com', 'secret-1');
      const oldHandle = first.user;
      await signOut(h.clientAuth);

      clock.set(Date.UTC(2026, 6, 1, 12, 5, 0));
      const revokeReply = await h.sendRaw({ method: 'auth.adminRevokeRefreshTokens', uid: oldHandle.uid });
      expect(revokeReply.ok).toBe(true);

      clock.set(Date.UTC(2026, 6, 1, 12, 10, 0));
      const second = await signInWithEmailAndPassword(h.clientAuth, 'rev@example.com', 'secret-1');
      const newHandle = second.user;

      // Old held handle was minted before revocation; refreshing it fails without signing out newHandle.
      await expectRejectionCode(oldHandle.getIdToken(true), 'auth/user-token-expired');
      expect(h.clientAuth.currentUser?.uid).toBe(newHandle.uid);
      expect((await newHandle.getIdTokenResult(true)).claims.user_id).toBe(newHandle.uid);

      // Multi-tenant held handle keeps its tenant claims after switching to another tenant.
      h.clientAuth.tenantId = 'tenant-red';
      const redCred = await createUserWithEmailAndPassword(h.clientAuth, 'red@example.com', 'secret-1');
      const redUser = redCred.user;
      h.clientAuth.tenantId = 'tenant-blue';
      const blueCred = await createUserWithEmailAndPassword(h.clientAuth, 'blue@example.com', 'secret-1');
      const blueUser = blueCred.user;

      const redToken = await redUser.getIdTokenResult(true);
      const blueToken = await blueUser.getIdTokenResult(true);
      expect((redToken.claims.firebase as { tenant?: string }).tenant).toBe('tenant-red');
      expect((blueToken.claims.firebase as { tenant?: string }).tenant).toBe('tenant-blue');

      // Linking with a stale handle keeps auth/user-mismatch per served-auth-linking contract.
      await expectRejectionCode(
        linkWithCredential(redUser, EmailAuthProvider.credential('extra@example.com', 'secret-1')),
        'auth/user-mismatch',
      );
    } finally {
      h.dispose();
    }
  });

  it('refuses raw-port requests addressing a uid that never signed in on that port', async () => {
    const h = createHarness();
    try {
      const victim = await createUserWithEmailAndPassword(h.clientAuth, 'victim@example.com', 'secret-1');

      // rawPort has never authenticated victim.
      const tokenWhenSignedOut = await h.sendRaw({ method: 'auth.getIdToken', uid: victim.user.uid, tenantId: null });
      expect(tokenWhenSignedOut).toMatchObject({ ok: false, error: { code: 'auth/no-current-user' } });

      const deleteWhenSignedOut = await h.sendRaw({ method: 'auth.deleteUser', uid: victim.user.uid, tenantId: null });
      expect(deleteWhenSignedOut).toMatchObject({ ok: false, error: { code: 'auth/no-current-user' } });

      // Sign in as attacker on rawPort and attempt to address victim.
      const attackerReply = await h.sendRaw({
        method: 'auth.createUser',
        email: 'attacker@example.com',
        password: 'secret-1',
      });
      expect(attackerReply.ok).toBe(true);

      const forgedOps: Array<Record<string, unknown>> = [
        { method: 'auth.getIdToken', uid: victim.user.uid, tenantId: null },
        { method: 'auth.getIdTokenResult', uid: victim.user.uid, tenantId: null },
        { method: 'auth.updateProfile', uid: victim.user.uid, tenantId: null, displayName: 'Hijacked' },
        { method: 'auth.reload', uid: victim.user.uid, tenantId: null },
        { method: 'auth.deleteUser', uid: victim.user.uid, tenantId: null },
        { method: 'auth.updateEmail', uid: victim.user.uid, tenantId: null, email: 'hijack@example.com' },
        { method: 'auth.updatePassword', uid: victim.user.uid, tenantId: null, password: 'hijacked-password' },
      ];
      for (const op of forgedOps) {
        const reply = await h.sendRaw(op);
        expect(reply).toMatchObject({ ok: false, error: { code: 'auth/user-mismatch' } });
      }
      const victimRecord = authSandbox.listUsers(getInPageAuth(h.sandbox)).find((u) => u.uid === victim.user.uid);
      expect(victimRecord?.email).toBe('victim@example.com');
      expect(victimRecord?.displayName).toBeNull();
    } finally {
      h.dispose();
    }
  });
});

describe('served auth.acceptIdentity and auth.mockSignInResult hardening (#1491)', () => {
  const INVALID_PROVIDER_IDS = [
    '',
    ' ',
    'Password',
    'password ',
    ' password',
    'GOOGLE.COM',
    'emailLink',
    'firebase',
    'oidc',
    'oidc.',
    'saml.',
    'acme',
    'phone ',
    'Anonymous',
  ];

  it('rejects empty/whitespace uid and look-alike provider ids on both acceptIdentity and mockSignInResult', async () => {
    const h = createHarness();
    try {
      const inPageAuth = getInPageAuth(h.sandbox);
      authSandbox.setAuthProviderConfig(inPageAuth, 'phone', true);
      authSandbox.setAuthProviderConfig(inPageAuth, 'google.com', true);
      const owner = await createUserWithEmailAndPassword(h.clientAuth, 'owner@example.com', 'secret-123');
      await signOut(h.clientAuth);

      for (const method of ['auth.acceptIdentity', 'auth.mockSignInResult'] as const) {
        for (const badUid of ['', '   ', '\t\n']) {
          const reply = await h.sendRaw({
            method,
            identity: {
              uid: badUid,
              providerId: 'phone',
              email: 'owner@example.com',
              displayName: null,
              photoURL: null,
              customClaims: {},
            },
          });
          expect(reply).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
          expect(portSession(h.ctx, h.rawPort)).toBeNull();
        }

        for (const badProviderId of INVALID_PROVIDER_IDS) {
          const reply = await h.sendRaw({
            method,
            identity: {
              uid: owner.user.uid,
              providerId: badProviderId,
              email: 'owner@example.com',
              displayName: null,
              photoURL: null,
              customClaims: {},
            },
          });
          expect(reply).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
          expect(portSession(h.ctx, h.rawPort)).toBeNull();
        }
      }

      // Owner's providerData remains untouched (no look-alike provider written).
      const ownerRecord = authSandbox.listUsers(inPageAuth).find((u) => u.uid === owner.user.uid);
      expect(ownerRecord?.providerUserInfo.map((p) => p.providerId)).toEqual(['password']);

      // Client stageSignInResult also refuses whitespace uid and look-alike providerId synchronously.
      expect(() => stageSignInResult(h.clientAuth, { user: { uid: '   ' }, providerId: 'google.com' })).toThrow('non-empty');
      expect(() => stageSignInResult(h.clientAuth, { user: { uid: owner.user.uid }, providerId: 'Password' })).toThrow('unsupported providerId');
      expect(() => stageSignInResult(h.clientAuth, { user: { uid: owner.user.uid }, providerId: 'acme' })).toThrow('unsupported providerId');

      // Direct seeder seam fails closed as defense-in-depth.
      expect(() => resolveOAuthCredentialUser(inPageAuth, {
        uid: '',
        providerId: 'google.com',
        email: 'owner@example.com',
      })).toThrow('identity.uid');
      expect(() => resolveOAuthCredentialUser(inPageAuth, {
        uid: owner.user.uid,
        providerId: 'Password',
        email: 'owner@example.com',
      })).toThrow('identity.providerId');
    } finally {
      h.dispose();
    }
  });

  it('continues accepting real federated, password, phone, and anonymous provider ids with non-empty uid', async () => {
    const h = createHarness();
    try {
      const inPageAuth = getInPageAuth(h.sandbox);
      for (const providerId of ['google.com', 'oidc.acme', 'saml.corp', 'phone', 'password', 'anonymous']) {
        authSandbox.setAuthProviderConfig(inPageAuth, providerId, true);
        const uid = `valid-${providerId}`;
        const reply = await h.sendRaw({
          method: 'auth.acceptIdentity',
          identity: {
            uid,
            providerId,
            email: `${uid}@example.com`,
            displayName: null,
            photoURL: null,
            customClaims: {},
          },
        });
        expect(reply.ok).toBe(true);
        if (reply.ok) {
          const cred = reply.value as { user: SerializedUser; providerId: string | null };
          expect(cred.user.uid).toBe(uid);
          expect(cred.providerId).toBe(providerId);
        }
      }
    } finally {
      h.dispose();
    }
  });
});
