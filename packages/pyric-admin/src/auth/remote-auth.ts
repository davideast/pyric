/**
 * Remote sandbox `Auth` implementation for `pyric-admin/auth`, relaying user
 * CRUD operations over the worker channel onto the shared browser user pool.
 */
import type { RemoteSandbox } from 'pyric/sandbox';
import type { AuthAccountStanding } from 'pyric/sandbox/internal';
import type {
  AuthUserRecord,
  UpdateUserRequest as SandboxUpdateUserRequest,
} from 'pyric/auth';
import type { PyricAdminApp } from '../app/index.js';
import type {
  Auth,
  CreateRequest,
  DecodedIdToken,
  ListUsersResult,
  UpdateRequest,
  UserRecord,
} from './types.js';
import {
  assertCustomTokenArguments,
  assertValidCustomUserClaims,
  fromAuthUserRecord,
  idTokenProjectId,
  mintSandboxCustomToken,
  toSandboxCreateRequest,
  translateAdminBackendError,
  validateAdminEmail,
  validateAdminPassword,
} from './validation.js';
import {
  assertIdTokenArgument,
  assertNotRevokedOrDisabled,
  FirebaseAuthError,
  invalidUid,
  verifySandboxIdToken,
} from './verify-token.js';

const UNSUPPORTED_UPDATE_KEYS = [
  'photoURL',
  'phoneNumber',
  'multiFactor',
  'providerToLink',
  'providersToUnlink',
] as const;

function notImplemented(method: string): Error {
  return new Error(
    `pyric-admin/auth: ${method} is not implemented in pyric-admin/auth remote sandbox backend`,
  );
}

/**
 * Build the remote `Auth` handle backed by the worker channel on `sandbox`.
 */
export function makeRemoteAuth(app: PyricAdminApp, sandbox: RemoteSandbox): Auth {
  const channel = sandbox.channel;

  const listRecords = async (): Promise<AuthUserRecord[]> =>
    (await channel.op({ method: 'auth.listUsers' })) as AuthUserRecord[];

  const sandboxNow = async (): Promise<number> =>
    ((await channel.op({ method: 'sandbox.clock' })) as { now: number }).now;

  const relayedStanding = async (uid: string): Promise<AuthAccountStanding> => {
    const record = (await listRecords()).find((u) => u.uid === uid);
    if (record === undefined) return { kind: 'unrecorded' };
    if (record.disabled) return { kind: 'disabled' };
    return { kind: 'active', tokensValidAfterMs: null };
  };

  const handle: Auth = {
    get app(): PyricAdminApp {
      throw notImplemented('auth.app');
    },

    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
      assertCustomTokenArguments(uid, developerClaims);
      return sandboxNow().then((nowMs) => mintSandboxCustomToken(app, nowMs, uid, developerClaims));
    },

    verifyIdToken(idToken: string, checkRevoked = false): Promise<DecodedIdToken> {
      assertIdTokenArgument(idToken);
      const projectId = idTokenProjectId(app);
      const verified = sandboxNow().then((nowMs) => verifySandboxIdToken(idToken, { projectId, nowMs }));
      if (!checkRevoked) return verified;
      return verified.then(async (decoded) =>
        assertNotRevokedOrDisabled(decoded, await relayedStanding(decoded.sub)),
      );
    },

    async createUser(properties: CreateRequest): Promise<UserRecord> {
      if (properties.uid !== undefined) {
        const uidErr = invalidUid(properties.uid);
        if (uidErr !== null) throw uidErr;
      }
      if (properties.email !== undefined) {
        const emailErr = validateAdminEmail(properties.email);
        if (emailErr !== null) throw emailErr;
      }
      if (properties.password !== undefined) {
        const pwErr = validateAdminPassword(properties.password);
        if (pwErr !== null) throw pwErr;
      }
      try {
        const record = await channel.op({
          method: 'auth.adminCreateUser',
          request: toSandboxCreateRequest(properties) as unknown as Record<string, unknown>,
        });
        return fromAuthUserRecord(record as AuthUserRecord);
      } catch (err) {
        throw translateAdminBackendError(err);
      }
    },

    async getUser(uid: string): Promise<UserRecord> {
      const record = (await listRecords()).find((u) => u.uid === uid);
      if (!record) {
        throw new FirebaseAuthError(
          'user-not-found',
          `pyric-admin/auth: getUser failed: no user with uid "${uid}"`,
        );
      }
      return fromAuthUserRecord(record);
    },

    async getUserByEmail(email: string): Promise<UserRecord> {
      const emailErr = validateAdminEmail(email);
      if (emailErr !== null) throw emailErr;
      const targetEmail = email.toLowerCase();
      const record = (await listRecords()).find(
        (u) => u.email !== null && u.email.toLowerCase() === targetEmail,
      );
      if (!record) {
        throw new FirebaseAuthError(
          'user-not-found',
          `pyric-admin/auth: getUserByEmail failed: no user with email "${email}"`,
        );
      }
      return fromAuthUserRecord(record);
    },

    async listUsers(maxResults?: number, _pageToken?: string): Promise<ListUsersResult> {
      let records = await listRecords();
      if (maxResults !== undefined) records = records.slice(0, maxResults);
      return { users: records.map(fromAuthUserRecord) };
    },

    async updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
      const propRecord = properties as Record<string, unknown>;
      const unsupported = UNSUPPORTED_UPDATE_KEYS.filter(
        (key) => Object.hasOwn(propRecord, key) && propRecord[key] !== undefined,
      );
      if (unsupported.length > 0) {
        throw notImplemented(`updateUser({ ${unsupported.join(', ')} })`);
      }
      if (properties.email !== undefined) {
        const emailErr = validateAdminEmail(properties.email);
        if (emailErr !== null) throw emailErr;
      }
      if (properties.password !== undefined) {
        const pwErr = validateAdminPassword(properties.password);
        if (pwErr !== null) throw pwErr;
      }
      const request: SandboxUpdateUserRequest = {
        displayName: properties.displayName,
        email: properties.email,
        password: properties.password,
        disabled: properties.disabled,
        emailVerified: properties.emailVerified,
      };
      try {
        const record = await channel.op({
          method: 'auth.adminUpdateUser',
          uid,
          request: request as unknown as Record<string, unknown>,
        });
        return fromAuthUserRecord(record as AuthUserRecord);
      } catch (err) {
        throw translateAdminBackendError(err);
      }
    },

    async deleteUser(uid: string): Promise<void> {
      await channel.op({ method: 'auth.adminDeleteUser', uid });
    },

    async setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void> {
      assertValidCustomUserClaims(customUserClaims);
      await channel.op({
        method: 'auth.adminUpdateUser',
        uid,
        request: { customClaims: customUserClaims ?? {} },
      });
    },

    getUserByPhoneNumber(): Promise<UserRecord> {
      return Promise.reject(notImplemented('getUserByPhoneNumber'));
    },
    getUserByProviderUid(): Promise<UserRecord> {
      return Promise.reject(notImplemented('getUserByProviderUid'));
    },
    getUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('getUsers'));
    },
    deleteUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('deleteUsers'));
    },
    importUsers(): Promise<unknown> {
      return Promise.reject(notImplemented('importUsers'));
    },
    revokeRefreshTokens(uid: string): Promise<void> {
      const uidError = invalidUid(uid);
      if (uidError !== null) return Promise.reject(uidError);
      return Promise.reject(notImplemented('revokeRefreshTokens'));
    },
    createSessionCookie(): Promise<string> {
      return Promise.reject(notImplemented('createSessionCookie'));
    },
    verifySessionCookie(): Promise<DecodedIdToken> {
      return Promise.reject(notImplemented('verifySessionCookie'));
    },
    generatePasswordResetLink(): Promise<string> {
      return Promise.reject(notImplemented('generatePasswordResetLink'));
    },
    generateEmailVerificationLink(): Promise<string> {
      return Promise.reject(notImplemented('generateEmailVerificationLink'));
    },
    generateSignInWithEmailLink(): Promise<string> {
      return Promise.reject(notImplemented('generateSignInWithEmailLink'));
    },
    generateVerifyAndChangeEmailLink(): Promise<string> {
      return Promise.reject(notImplemented('generateVerifyAndChangeEmailLink'));
    },
    createProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('createProviderConfig'));
    },
    getProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('getProviderConfig'));
    },
    listProviderConfigs(): Promise<unknown> {
      return Promise.reject(notImplemented('listProviderConfigs'));
    },
    updateProviderConfig(): Promise<unknown> {
      return Promise.reject(notImplemented('updateProviderConfig'));
    },
    deleteProviderConfig(): Promise<void> {
      return Promise.reject(notImplemented('deleteProviderConfig'));
    },
    get tenantManager(): never {
      throw notImplemented('tenantManager');
    },
    get projectConfigManager(): never {
      throw notImplemented('projectConfigManager');
    },
  };
  return handle;
}
