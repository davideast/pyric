/**
 * Remote sandbox `Auth` implementation for `pyric-admin/auth`, relaying user
 * CRUD operations over the worker channel onto the shared browser user pool.
 */
import type { RemoteSandbox } from 'pyric/sandbox';
import type { AuthAccountStanding } from 'pyric/sandbox/internal';
import type { AuthUserRecord } from 'pyric/auth';
import type { PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { validateCreateUserPreflight } from './preflight-validation.js';
import { buildUnmodeledAuthPreflightMethods } from './session-and-link-preflight.js';
import { Auth } from './auth.js';
import type {
  BaseAuthDelegate,
  CreateRequest,
  DecodedIdToken,
  ListUsersResult,
  UpdateRequest,
} from './types.js';
import type { UserRecord } from './user-record.js';
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

  const delegate: BaseAuthDelegate = {
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
    ...buildUnmodeledAuthPreflightMethods(app, notImplemented),
  };
  return new Auth(app, delegate, (method) => {
    assertAdminAppActive(app);
    throw notImplemented(method);
  });
}
