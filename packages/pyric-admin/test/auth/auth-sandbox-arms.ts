/**
 * Local in-process and JSON-wire remote sandbox arm builders for the
 * `pyric-admin/auth` generative argument differential suite.
 */

import {
  REMOTE_SANDBOX,
  initializeSandbox,
  type RemoteSandbox,
  type RemoteSandboxChannel,
  type Sandbox,
} from 'pyric/sandbox';
import {
  authAccountsFor,
  getClock,
  idTokenAudience,
  mintIdToken,
} from 'pyric/sandbox/internal';
import {
  getAuth as getClientAuth,
  sandbox as clientAuthSandbox,
  type CreateUserRequest as SandboxCreateUserRequest,
  type UpdateUserRequest as SandboxUpdateUserRequest,
} from 'pyric/auth';
import {
  deleteApp,
  initializeApp,
  type PyricAdminApp,
} from '../../src/app/index.js';
import {
  getAuth,
  type Auth,
} from '../../src/auth/index.js';

export const AUTH_DIFF_PROJECT_ID = 'demo-project';
export const AUTH_FIXED_NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

export interface AuthSchemaSeed {
  readonly existingUid: string;
  readonly existingEmail: string;
  readonly secondEmail: string;
  readonly validIdToken: string;
  readonly expiredIdToken: string;
  readonly wrongAudIdToken: string;
  readonly customToken: string;
  readonly validSessionCookieJwt: string;
  readonly validPageToken: string;
}

export interface AuthSandboxArm {
  readonly label: 'local' | 'remote';
  readonly app: PyricAdminApp;
  readonly svc: Auth;
  readonly resetAndSeed: () => Promise<AuthSchemaSeed>;
  readonly dispose: () => Promise<void>;
}

let armSequence = 0;

function overJsonWire<T>(frame: T): T {
  const serialized = JSON.stringify(frame);
  if (serialized === undefined) {
    return undefined as T;
  }
  return JSON.parse(serialized) as T;
}

function relayErrorOverJsonWire(error: unknown): Error {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const wireError = overJsonWire({
    message,
    code: typeof code === 'string' ? code : undefined,
  });
  const reconstructed = new Error(wireError.message) as Error & { code?: string };
  if (wireError.code !== undefined) {
    reconstructed.code = wireError.code;
  }
  return reconstructed;
}

function createJsonRelayRemoteAuthSandbox(hostSandbox: Sandbox): RemoteSandbox {
  const clientAuth = getClientAuth(hostSandbox);
  const channel: RemoteSandboxChannel = {
    async op(rawOp) {
      const wireOp = overJsonWire(rawOp);
      try {
        if (wireOp.method === 'sandbox.clock') {
          return overJsonWire({ now: getClock(hostSandbox).now() });
        }
        if (wireOp.method === 'auth.listUsers') {
          return overJsonWire(clientAuthSandbox.listUsers(clientAuth));
        }
        if (wireOp.method === 'auth.adminCreateUser') {
          const created = clientAuthSandbox.createUser(
            clientAuth,
            wireOp.request as SandboxCreateUserRequest,
          );
          return overJsonWire(created);
        }
        if (wireOp.method === 'auth.adminUpdateUser') {
          const updated = clientAuthSandbox.updateUser(
            clientAuth,
            String(wireOp.uid),
            wireOp.request as SandboxUpdateUserRequest,
          );
          return overJsonWire(updated);
        }
        if (wireOp.method === 'auth.adminDeleteUser') {
          clientAuthSandbox.deleteUser(clientAuth, String(wireOp.uid));
          return null;
        }
        if (wireOp.method === 'auth.adminGetAccountStanding') {
          const standing = authAccountsFor(hostSandbox)?.standing(String(wireOp.uid)) ?? {
            kind: 'unrecorded',
          };
          return overJsonWire(standing);
        }
        if (wireOp.method === 'auth.adminRevokeRefreshTokens') {
          const accounts = authAccountsFor(hostSandbox);
          const standing = accounts?.standing(String(wireOp.uid)) ?? { kind: 'unrecorded' };
          const hasRecord = standing.kind === 'active' || standing.kind === 'disabled';
          if (!hasRecord || accounts === undefined) {
            const missingErr = new Error(
              'There is no user record corresponding to the provided identifier.',
            ) as Error & { code: string };
            missingErr.code = 'auth/user-not-found';
            throw missingErr;
          }
          accounts.revokeRefreshTokens(String(wireOp.uid));
          return null;
        }
        throw new Error(`Unsupported remote auth op: ${String(wireOp.method)}`);
      } catch (error) {
        throw relayErrorOverJsonWire(error);
      }
    },
    subscribe() {
      return () => {};
    },
  };

  return {
    ...hostSandbox,
    [REMOTE_SANDBOX]: true,
    serveUrl: 'http://localhost:5000',
    channel,
  };
}

export function createAuthArm(kind: 'local' | 'remote'): AuthSandboxArm {
  const hostSandbox = initializeSandbox({ projectId: AUTH_DIFF_PROJECT_ID });
  getClock(hostSandbox).set(AUTH_FIXED_NOW_MS);

  let targetSandbox: Sandbox = hostSandbox;
  if (kind === 'remote') {
    targetSandbox = createJsonRelayRemoteAuthSandbox(hostSandbox);
  }
  const app = initializeApp(
    { sandbox: targetSandbox, projectId: AUTH_DIFF_PROJECT_ID },
    `auth-gen-${kind}-${++armSequence}`,
  );
  const svc = getAuth(app);

  return {
    label: kind,
    app,
    svc,
    async resetAndSeed() {
      hostSandbox.reset();
      clientAuthSandbox.clearUsers(getClientAuth(hostSandbox));
      authAccountsFor(hostSandbox)?.forgetHistory();
      getClock(hostSandbox).set(AUTH_FIXED_NOW_MS);
      const existingUid = 'user-1';
      const existingEmail = 'user-1@example.com';
      const secondEmail = 'user-2@example.com';
      await svc.createUser({
        uid: existingUid,
        email: existingEmail,
        password: 'secret-password',
      });
      await svc.createUser({
        uid: 'user-2',
        email: secondEmail,
        password: 'secret-password',
      });
      const nowSec = Math.floor(AUTH_FIXED_NOW_MS / 1000);
      const validIdToken = mintIdToken({
        ...idTokenAudience(AUTH_DIFF_PROJECT_ID),
        sub: existingUid,
        user_id: existingUid,
        iat: nowSec,
        auth_time: nowSec,
        exp: nowSec + 3600,
        firebase: { identities: {}, sign_in_provider: 'password' },
      });
      const expiredIdToken = mintIdToken({
        ...idTokenAudience(AUTH_DIFF_PROJECT_ID),
        sub: existingUid,
        user_id: existingUid,
        iat: nowSec - 7200,
        auth_time: nowSec - 7200,
        exp: nowSec - 3600,
        firebase: { identities: {}, sign_in_provider: 'password' },
      });
      const wrongAudIdToken = mintIdToken({
        ...idTokenAudience('other-project'),
        sub: existingUid,
        user_id: existingUid,
        iat: nowSec,
        auth_time: nowSec,
        exp: nowSec + 3600,
        firebase: { identities: {}, sign_in_provider: 'password' },
      });
      const customToken = await svc.createCustomToken(existingUid, { role: 'member' });
      const validSessionCookieJwt = await svc.createSessionCookie(validIdToken, {
        expiresIn: 60 * 60 * 1000,
      });
      const firstPage = await svc.listUsers(1);
      const validPageToken = firstPage.pageToken ?? 'fallback-token';
      return {
        existingUid,
        existingEmail,
        secondEmail,
        validIdToken,
        expiredIdToken,
        wrongAudIdToken,
        customToken,
        validSessionCookieJwt,
        validPageToken,
      };
    },
    async dispose() {
      await deleteApp(app).catch(() => {});
      hostSandbox.dispose();
    },
  };
}
