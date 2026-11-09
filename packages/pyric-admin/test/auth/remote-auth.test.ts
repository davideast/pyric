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

    const updated = await auth.updateUser('user-r1', { displayName: 'Updated Name', disabled: true });
    expect(updated.displayName).toBe('Updated Name');
    expect(updated.disabled).toBe(true);

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

    await expect(auth.updateUser('user-r3', { photoURL: 'https://example.com/p.png' })).rejects.toThrow(
      /not implemented/,
    );
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
});
