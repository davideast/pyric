/**
 * Remote sandbox `Auth` implementation for `pyric-admin/auth`, relaying user
 * CRUD operations over the worker channel onto the shared browser user pool.
 */
import type { RemoteSandbox } from 'pyric/sandbox';
import type { AuthAccountStanding } from 'pyric/sandbox/internal';
import type { AuthUserRecord } from 'pyric/auth';
import type { PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import {
  assertDeleteUsersPreflight,
  assertGetUsersPreflight,
  assertPhoneNumberPreflight,
  validateCreateUserPreflight,
} from './preflight-validation.js';
import {
  assertCreateSessionCookiePreflight,
  assertEmailActionLinkPreflight,
  assertVerifySessionCookiePreflight,
} from './session-and-link-preflight.js';
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
  fromAuthUserRecord,
  idTokenProjectId,
  mintSandboxCustomToken,
  normalizeCustomUserClaims,
  paginateUserRecords,
  prepareSandboxUpdateRequest,
  toSandboxCreateRequest,
  translateAdminBackendError,
  validateAdminEmail,
  validateListUsersArguments,
} from './validation.js';
import {
  assertIdTokenArgument,
  assertNotRevokedOrDisabled,
  FirebaseAuthError,
  invalidUid,
  verifySandboxIdToken,
} from './verify-token.js';

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

  const relayedStanding = async (uid: string): Promise<AuthAccountStanding> =>
    (await channel.op({ method: 'auth.adminGetAccountStanding', uid })) as AuthAccountStanding;

  const handle: Auth = {
    get app(): PyricAdminApp {
      return app;
    },

    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
      assertAdminAppActive(app);
      assertCustomTokenArguments(uid, developerClaims);
      return sandboxNow().then((nowMs) => mintSandboxCustomToken(app, nowMs, uid, developerClaims));
    },

    verifyIdToken(idToken: string, checkRevoked = false): Promise<DecodedIdToken> {
      assertAdminAppActive(app);
      assertIdTokenArgument(idToken);
      const projectId = idTokenProjectId(app);
      const verified = sandboxNow().then((nowMs) => verifySandboxIdToken(idToken, { projectId, nowMs }));
      if (!checkRevoked) return verified;
      return verified.then(async (decoded) =>
        assertNotRevokedOrDisabled(decoded, await relayedStanding(decoded.sub)),
      );
    },

    async createUser(properties: CreateRequest): Promise<UserRecord> {
      assertAdminAppActive(app);
      const validated = validateCreateUserPreflight(properties);
      try {
        const record = await channel.op({
          method: 'auth.adminCreateUser',
          request: toSandboxCreateRequest(validated) as unknown as Record<string, unknown>,
        });
        return fromAuthUserRecord(record as AuthUserRecord);
      } catch (err) {
        throw translateAdminBackendError(err);
      }
    },

    async getUser(uid: string): Promise<UserRecord> {
      assertAdminAppActive(app);
      const uidErr = invalidUid(uid);
      if (uidErr !== null) throw uidErr;
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
      assertAdminAppActive(app);
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

    async listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
      assertAdminAppActive(app);
      validateListUsersArguments(maxResults, pageToken);
      const records = await listRecords();
      return paginateUserRecords(records, maxResults, pageToken);
    },

    async updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
      assertAdminAppActive(app);
      const request = prepareSandboxUpdateRequest(uid, properties, notImplemented);
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
      assertAdminAppActive(app);
      const uidErr = invalidUid(uid);
      if (uidErr !== null) throw uidErr;
      try {
        await channel.op({ method: 'auth.adminDeleteUser', uid });
      } catch (err) {
        throw translateAdminBackendError(err);
      }
    },

    async setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void> {
      assertAdminAppActive(app);
      const uidErr = invalidUid(uid);
      if (uidErr !== null) throw uidErr;
      const claimsMap = normalizeCustomUserClaims(customUserClaims);
      try {
        await channel.op({
          method: 'auth.adminUpdateUser',
          uid,
          request: { customClaims: claimsMap },
        });
      } catch (err) {
        throw translateAdminBackendError(err);
      }
    },

    getUserByPhoneNumber(phoneNumber?: unknown): Promise<UserRecord> {
      assertAdminAppActive(app);
      try {
        assertPhoneNumberPreflight(phoneNumber);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('getUserByPhoneNumber'));
    },
    getUserByProviderUid(): Promise<UserRecord> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getUserByProviderUid'));
    },
    getUsers(identifiers?: unknown): Promise<unknown> {
      assertAdminAppActive(app);
      assertGetUsersPreflight(identifiers);
      return Promise.reject(notImplemented('getUsers'));
    },
    deleteUsers(uids?: unknown): Promise<unknown> {
      assertAdminAppActive(app);
      assertDeleteUsersPreflight(uids);
      return Promise.reject(notImplemented('deleteUsers'));
    },
    importUsers(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('importUsers'));
    },
    async revokeRefreshTokens(uid: string): Promise<void> {
      assertAdminAppActive(app);
      const uidError = invalidUid(uid);
      if (uidError !== null) throw uidError;
      try {
        await channel.op({ method: 'auth.adminRevokeRefreshTokens', uid });
      } catch (err) {
        throw translateAdminBackendError(err);
      }
    },
    createSessionCookie(idToken?: unknown, sessionCookieOptions?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertCreateSessionCookiePreflight(idToken, sessionCookieOptions);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('createSessionCookie'));
    },
    verifySessionCookie(sessionCookie?: unknown): Promise<DecodedIdToken> {
      assertAdminAppActive(app);
      if (typeof sessionCookie !== 'string') {
        assertVerifySessionCookiePreflight(sessionCookie, idTokenProjectId(app));
      }
      try {
        assertVerifySessionCookiePreflight(sessionCookie, idTokenProjectId(app));
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('verifySessionCookie'));
    },
    generatePasswordResetLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight('PASSWORD_RESET', email, actionCodeSettings);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generatePasswordResetLink'));
    },
    generateEmailVerificationLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight('VERIFY_EMAIL', email, actionCodeSettings);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generateEmailVerificationLink'));
    },
    generateSignInWithEmailLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight('EMAIL_SIGNIN', email, actionCodeSettings);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generateSignInWithEmailLink'));
    },
    generateVerifyAndChangeEmailLink(
      email?: unknown,
      newEmail?: unknown,
      actionCodeSettings?: unknown,
    ): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight(
          'VERIFY_AND_CHANGE_EMAIL',
          email,
          actionCodeSettings,
          newEmail,
        );
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generateVerifyAndChangeEmailLink'));
    },
    createProviderConfig(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('createProviderConfig'));
    },
    getProviderConfig(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getProviderConfig'));
    },
    listProviderConfigs(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('listProviderConfigs'));
    },
    updateProviderConfig(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('updateProviderConfig'));
    },
    deleteProviderConfig(): Promise<void> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('deleteProviderConfig'));
    },
    get tenantManager(): never {
      assertAdminAppActive(app);
      throw notImplemented('tenantManager');
    },
    get projectConfigManager(): never {
      assertAdminAppActive(app);
      throw notImplemented('projectConfigManager');
    },
  };
  return handle;
}
