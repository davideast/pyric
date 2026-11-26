import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type RemoteSandboxChannel } from 'pyric/sandbox';
import {
  authAccountsFor,
  getClock,
  idTokenAudience,
  mintIdToken,
  SANDBOX_PROJECT_ID,
} from 'pyric/sandbox/internal';
import {
  getAuth as getClientAuth,
  sandbox as clientAuthSandbox,
  type CreateUserRequest,
  type UpdateUserRequest,
} from 'pyric/auth';
import { createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';
import { createWorkerBridgeRemoteAuth } from './worker-bridge-helper.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function createBackedRemoteAuth(appName: string) {
  const backing = initializeSandbox();
  const clientAuth = getClientAuth(backing);
  const channel: RemoteSandboxChannel = {
    op: async (payload) => {
      const method = payload.method;
      if (method === 'sandbox.clock') {
        return { now: getClock(backing).now() };
      }
      if (method === 'auth.listUsers') {
        return clientAuthSandbox.listUsers(clientAuth);
      }
      if (method === 'auth.adminCreateUser') {
        return clientAuthSandbox.createUser(clientAuth, payload.request as CreateUserRequest);
      }
      if (method === 'auth.adminUpdateUser') {
        return clientAuthSandbox.updateUser(
          clientAuth,
          String(payload.uid),
          payload.request as UpdateUserRequest,
        );
      }
      if (method === 'auth.adminDeleteUser') {
        clientAuthSandbox.deleteUser(clientAuth, String(payload.uid));
        return null;
      }
      if (method === 'auth.adminGetAccountStanding') {
        return authAccountsFor(backing)?.standing(String(payload.uid)) ?? { kind: 'unrecorded' };
      }
      if (method === 'auth.adminRevokeRefreshTokens') {
        const accounts = authAccountsFor(backing);
        const standing = accounts?.standing(String(payload.uid)) ?? { kind: 'unrecorded' };
        if (standing.kind !== 'active' && standing.kind !== 'disabled') {
          throw Object.assign(
            new Error('There is no user record corresponding to the provided identifier.'),
            { code: 'auth/user-not-found' },
          );
        }
        accounts!.revokeRefreshTokens(String(payload.uid));
        return null;
      }
      throw new Error(`Unexpected op: ${String(method)}`);
    },
    subscribe: () => () => {},
  };
  const remote = createRemoteSandboxHandle({
    channel,
    serveUrl: 'http://localhost:0',
    close: () => {},
  });
  const app = initializeApp({ sandbox: remote }, appName);
  return { backing, remote, app, auth: getAuth(app) };
}

describe('remote sandbox Auth arm', () => {
  it('relays user CRUD, case-insensitive lookup, claims, and maxResults pagination', async () => {
    const { auth } = createBackedRemoteAuth('remote-crud');
    const created = await auth.createUser({
      uid: 'user-r1',
      email: 'remote@example.com',
      password: 'secret-pw',
      displayName: 'Remote User',
    });
    expect(created.uid).toBe('user-r1');

    await auth.createUser({ uid: 'user-r2', email: 'second@example.com', password: 'secret-pw' });
    const singlePage = await auth.listUsers(1);
    expect(singlePage.users).toHaveLength(1);

    const byEmail = await auth.getUserByEmail('REMOTE@EXAMPLE.COM');
    expect(byEmail.uid).toBe('user-r1');

    const updated = await auth.updateUser('user-r1', {
      displayName: 'Updated Name',
      photoURL: 'https://example.com/p.png',
      phoneNumber: '+15555550177',
      disabled: true,
    });
    expect(updated.displayName).toBe('Updated Name');
    expect(updated.photoURL).toBe('https://example.com/p.png');
    expect(updated.phoneNumber).toBe('+15555550177');
    expect(updated.providerData.map((p) => p.providerId).sort()).toEqual(['password', 'phone']);
    expect(updated.disabled).toBe(true);

    await expect(
      auth.updateUser('user-r2', {
        email: 'changed-second@example.com',
        phoneNumber: '+15555550177',
      }),
    ).rejects.toMatchObject({ code: 'auth/phone-number-already-exists' });
    expect((await auth.getUser('user-r2')).email).toBe('second@example.com');
    expect((await auth.getUserByEmail('second@example.com')).uid).toBe('user-r2');

    const cleared = await auth.updateUser('user-r1', {
      displayName: null,
      photoURL: null,
      phoneNumber: null,
    });
    expect(cleared.displayName).toBeUndefined();
    expect(cleared.photoURL).toBeUndefined();
    expect(cleared.phoneNumber).toBeUndefined();
    expect(cleared.providerData.map((p) => p.providerId)).toEqual(['password']);

    await auth.setCustomUserClaims('user-r1', { orgId: 'org-1' });
    const withClaims = await auth.getUser('user-r1');
    expect(withClaims.customClaims).toEqual({ orgId: 'org-1' });

    const nowSec = Math.floor(Date.now() / 1000);
    const idToken = mintIdToken({
      ...idTokenAudience(SANDBOX_PROJECT_ID),
      sub: 'user-r1',
      user_id: 'user-r1',
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
      firebase: { identities: {}, sign_in_provider: 'password' },
    });
    await expect(auth.verifyIdToken(idToken, true)).rejects.toMatchObject({
      code: 'auth/user-disabled',
    });

    await auth.deleteUser('user-r1');
    await expect(auth.getUser('user-r1')).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('rejects unsupported updateUser keys and validates inputs before relaying', async () => {
    const { auth } = createBackedRemoteAuth('remote-validation');
    await auth.createUser({ uid: 'user-r3', email: 'valid@example.com', password: 'secret-pw' });

    await expect(
      auth.updateUser('user-r3', { providersToUnlink: ['google.com'] }),
    ).rejects.toThrow(/not implemented/);
    await expect(auth.updateUser('user-r3', { photoURL: 'not-a-url' })).rejects.toMatchObject({
      code: 'auth/invalid-photo-url',
    });
    await expect(auth.updateUser('user-r3', { phoneNumber: '+abc' })).rejects.toMatchObject({
      code: 'auth/invalid-phone-number',
    });
    await expect(auth.createUser({ uid: '', email: 'a@b.com' })).rejects.toMatchObject({
      code: 'auth/invalid-uid',
    });
    await expect(auth.createUser({ uid: 'user-r4', email: 'invalid' })).rejects.toMatchObject({
      code: 'auth/invalid-email',
    });
    await expect(auth.createUser({ uid: 'user-r4', password: '123' })).rejects.toMatchObject({
      code: 'auth/invalid-password',
    });
    const noEmailErr = await auth
      .createUser({ uid: 'user-r5', password: 'secret-pw' })
      .catch((e: unknown) => e);
    expect(noEmailErr).toMatchObject({ code: 'auth/invalid-email' });
    expect(typeof (noEmailErr as { toJSON?: unknown }).toJSON).toBe('function');
  });

  it('rejects operations on a retained remote Auth handle after deleteApp(app)', async () => {
    const { app, auth } = createBackedRemoteAuth('remote-deleted-app');
    await deleteApp(app);

    await expect(
      Promise.resolve().then(() => auth.createCustomToken('user-1')),
    ).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(
      Promise.resolve().then(() =>
        auth.createUser({ uid: 'user-1', email: 'u1@example.com', password: 'secret-pw' }),
      ),
    ).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(
      Promise.resolve().then(() => auth.getUser('user-1')),
    ).rejects.toMatchObject({ code: 'app/app-deleted' });
  });

  it('exposes auth.app, paginates listUsers with pageToken and bounds checks, and wraps uid/backend errors in FirebaseAuthError', async () => {
    const { app, auth } = createBackedRemoteAuth('remote-parity');
    expect(auth.app).toBe(app);

    await auth.createUser({ uid: 'user-1', email: 'u1@example.com', password: 'secret-pw' });
    await auth.createUser({ uid: 'user-2', email: 'u2@example.com', password: 'secret-pw' });
    await auth.createUser({ uid: 'user-3', email: 'u3@example.com', password: 'secret-pw' });

    const page1 = await auth.listUsers(2);
    expect(page1.users.map((u) => u.uid)).toEqual(['user-1', 'user-2']);
    expect(typeof page1.pageToken).toBe('string');

    const page2 = await auth.listUsers(2, page1.pageToken);
    expect(page2.users.map((u) => u.uid)).toEqual(['user-3']);
    expect(page2.pageToken).toBeUndefined();

    await expect(auth.listUsers(0)).rejects.toMatchObject({ code: 'auth/argument-error' });
    await expect(auth.listUsers(1001)).rejects.toMatchObject({ code: 'auth/argument-error' });
    await expect(auth.listUsers(1, '')).rejects.toMatchObject({ code: 'auth/invalid-page-token' });
    await expect(auth.listUsers(1, 'invalid-cursor')).rejects.toMatchObject({
      code: 'auth/invalid-page-token',
    });

    for (const op of [
      () => auth.deleteUser(''),
      () => auth.getUser(''),
      () => auth.setCustomUserClaims('', { role: 'member' }),
      () => auth.updateUser('', { displayName: 'Nope' }),
    ]) {
      const err = await op().catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'auth/invalid-uid' });
      expect(typeof (err as { toJSON?: unknown }).toJSON).toBe('function');
    }

    for (const op of [
      () => auth.deleteUser('missing-user'),
      () => auth.setCustomUserClaims('missing-user', { role: 'member' }),
      () => auth.updateUser('missing-user', { displayName: 'Missing' }),
    ]) {
      const err = await op().catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'auth/user-not-found' });
      expect(typeof (err as { toJSON?: unknown }).toJSON).toBe('function');
    }
  });

  it('propagates tokensValidAfterTime on UserRecord and toJSON() across revokeRefreshTokens', async () => {
    const { backing, auth } = createBackedRemoteAuth('remote-valid-after');
    const clock = getClock(backing);
    const createdAtMs = Date.parse('2026-06-01T12:00:00.400Z');
    clock.set(createdAtMs);

    const created = await auth.createUser({ uid: 'u1', email: 'u1@example.com' });
    const expectedCreatedUtc = new Date(Math.floor(createdAtMs / 1000) * 1000).toUTCString();
    expect(created.tokensValidAfterTime).toBe(expectedCreatedUtc);
    expect(created.toJSON().tokensValidAfterTime).toBe(expectedCreatedUtc);

    const revokedAtMs = Date.parse('2026-06-01T12:03:45.800Z');
    clock.set(revokedAtMs);
    await auth.revokeRefreshTokens('u1');
    const expectedRevokedUtc = new Date(Math.floor(revokedAtMs / 1000) * 1000).toUTCString();

    const fetched = await auth.getUser('u1');
    const byEmail = await auth.getUserByEmail('u1@example.com');
    const listed = await auth.listUsers();
    for (const record of [fetched, byEmail, listed.users[0]]) {
      expect(record?.tokensValidAfterTime).toBe(expectedRevokedUtc);
      expect(record?.toJSON().tokensValidAfterTime).toBe(expectedRevokedUtc);
    }
  });

  it('advances listUsers(maxResults, pageToken) over hosted worker-bridge RemoteSandbox when the last-returned or next-boundary user is deleted', async () => {
    const stackA = await createWorkerBridgeRemoteAuth('remote-cursor-del-returned');
    const stackB = await createWorkerBridgeRemoteAuth('remote-cursor-del-next');
    try {
      const authA = stackA.auth;
      await authA.createUser({ uid: 'a1' });
      await authA.createUser({ uid: 'a2' });
      await authA.createUser({ uid: 'a3' });

      const pageA1 = await authA.listUsers(1);
      expect(pageA1.users.map((u) => u.uid)).toEqual(['a1']);
      expect(typeof pageA1.pageToken).toBe('string');

      await authA.deleteUser('a1');

      const pageA2 = await authA.listUsers(1, pageA1.pageToken);
      expect(pageA2.users.map((u) => u.uid)).toEqual(['a2']);
      expect(typeof pageA2.pageToken).toBe('string');

      const pageA3 = await authA.listUsers(1, pageA2.pageToken);
      expect(pageA3.users.map((u) => u.uid)).toEqual(['a3']);
      expect(pageA3.pageToken).toBeUndefined();

      const authB = stackB.auth;
      await authB.createUser({ uid: 'b1' });
      await authB.createUser({ uid: 'b2' });
      await authB.createUser({ uid: 'b3' });

      const pageB1 = await authB.listUsers(1);
      expect(pageB1.users.map((u) => u.uid)).toEqual(['b1']);
      expect(typeof pageB1.pageToken).toBe('string');

      await authB.deleteUser('b2');

      const pageB2 = await authB.listUsers(1, pageB1.pageToken);
      expect(pageB2.users.map((u) => u.uid)).toEqual(['b3']);
      expect(pageB2.pageToken).toBeUndefined();
    } finally {
      stackA.dispose();
      stackB.dispose();
    }
  });

  it('mints and verifies session cookies with checkRevoked over hosted worker-bridge RemoteSandbox', async () => {
    const stack = await createWorkerBridgeRemoteAuth('remote-session-cookie');
    try {
      const clock = getClock(stack.sandbox);
      const startMs = Date.UTC(2026, 6, 15, 8, 0, 0);
      clock.set(startMs);
      const nowSec = Math.floor(startMs / 1000);

      await stack.auth.createUser({
        uid: 'remote-ssr-1',
        email: 'remote-ssr@example.com',
        password: 'secret-password',
      });
      const idToken = mintIdToken({
        ...idTokenAudience(SANDBOX_PROJECT_ID),
        sub: 'remote-ssr-1',
        user_id: 'remote-ssr-1',
        email: 'remote-ssr@example.com',
        role: 'admin',
        iat: nowSec,
        auth_time: nowSec,
        exp: nowSec + 3600,
        firebase: { identities: {}, sign_in_provider: 'password' },
      });

      const sessionCookie = await stack.auth.createSessionCookie(idToken, {
        expiresIn: 60 * 60 * 1000,
      });
      const decoded = await stack.auth.verifySessionCookie(sessionCookie, true);
      expect(decoded.uid).toBe('remote-ssr-1');
      expect(decoded.email).toBe('remote-ssr@example.com');
      expect(decoded.role).toBe('admin');
      expect(decoded.iss).toBe(`https://session.firebase.google.com/${SANDBOX_PROJECT_ID}`);

      // Cross-token isolation on remote arm.
      await expect(stack.auth.verifyIdToken(sessionCookie)).rejects.toMatchObject({
        code: 'auth/argument-error',
      });
      await expect(stack.auth.verifySessionCookie(idToken)).rejects.toMatchObject({
        code: 'auth/argument-error',
      });

      // Revocation on remote arm rejects checkRevoked=true and createSessionCookie.
      clock.advance(2000);
      await stack.auth.revokeRefreshTokens('remote-ssr-1');
      await expect(stack.auth.verifySessionCookie(sessionCookie)).resolves.toMatchObject({
        uid: 'remote-ssr-1',
      });
      await expect(stack.auth.verifySessionCookie(sessionCookie, true)).rejects.toMatchObject({
        code: 'auth/session-cookie-revoked',
      });
      await expect(
        stack.auth.createSessionCookie(idToken, { expiresIn: 300_000 }),
      ).rejects.toMatchObject({ code: 'auth/id-token-expired' });

      // Disabled user rejects checkRevoked=true and createSessionCookie.
      await stack.auth.updateUser('remote-ssr-1', { disabled: true });
      await expect(stack.auth.verifySessionCookie(sessionCookie, true)).rejects.toMatchObject({
        code: 'auth/user-disabled',
      });
      await expect(
        stack.auth.createSessionCookie(idToken, { expiresIn: 300_000 }),
      ).rejects.toMatchObject({ code: 'auth/user-disabled' });

      // Deleted user rejects checkRevoked=true and createSessionCookie.
      await stack.auth.deleteUser('remote-ssr-1');
      await expect(stack.auth.verifySessionCookie(sessionCookie, true)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });

      // Clock past expiry rejects with auth/session-cookie-expired.
      clock.set(startMs + 60 * 60 * 1000);
      await expect(stack.auth.verifySessionCookie(sessionCookie)).rejects.toMatchObject({
        code: 'auth/session-cookie-expired',
      });

      // Deleted app rejects both methods.
      await deleteApp(stack.app);
      expect(() => stack.auth.createSessionCookie(idToken, { expiresIn: 300_000 })).toThrow(
        /has already been deleted/,
      );
      expect(() => stack.auth.verifySessionCookie(sessionCookie)).toThrow(
        /has already been deleted/,
      );
    } finally {
      stack.dispose();
    }
  });
});
