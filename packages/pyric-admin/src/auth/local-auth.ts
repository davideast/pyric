/**
 * In-process sandbox `Auth` implementation for `pyric-admin/auth`.
 */
import type { Sandbox, SandboxEvent } from 'pyric/sandbox';
import {
  authAccountsFor,
  getClock,
  type AuthAccountStanding,
} from 'pyric/sandbox/internal';
import {
  getAuth as getClientAuth,
  sandbox as clientAuthSandbox,
} from 'pyric/auth';
import type { PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
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
  paginateUserRecords,
  prepareSandboxUpdateRequest,
  toSandboxCreateRequest,
  translateAdminBackendError,
  validateAdminEmail,
  validateAdminPassword,
} from './validation.js';
import {
  assertNotRevokedOrDisabled,
  FirebaseAuthError,
  invalidUid,
  userNotFound,
  verifySandboxIdToken,
} from './verify-token.js';

/**
 * Per-sandbox deterministic auto-uid counter reset on `session_boundary` events.
 */
class AuthStore {
  private nextAutoUid = 1;

  mintUid(taken: ReadonlySet<string>): string {
    for (;;) {
      const n = String(this.nextAutoUid++).padStart(20, '0');
      const candidate = `pyric-sandbox-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  clear(): void {
    this.nextAutoUid = 1;
  }
}

const sandboxStores = new WeakMap<Sandbox, AuthStore>();
const sandboxesWithReset = new WeakSet<Sandbox>();

function storeFor(sandbox: Sandbox): AuthStore {
  let store = sandboxStores.get(sandbox);
  if (store) return store;
  store = new AuthStore();
  sandboxStores.set(sandbox, store);
  if (!sandboxesWithReset.has(sandbox)) {
    sandboxesWithReset.add(sandbox);
    sandbox.onEvent((event: SandboxEvent) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') {
        store!.clear();
        clientAuthSandbox.clearUsers(getClientAuth(sandbox));
        authAccountsFor(sandbox)?.forgetHistory();
      }
    });
  }
  return store;
}

function clientAccountStanding(sandbox: Sandbox, uid: string): AuthAccountStanding {
  return authAccountsFor(sandbox)?.standing(uid) ?? { kind: 'unrecorded' };
}

function notImplemented(method: string): Error {
  return new Error(
    `pyric-admin/auth: ${method} is not implemented in pyric-admin/auth sandbox backend`,
  );
}

/**
 * Build the in-process `Auth` handle for a sandbox app, synchronizing user
 * mutations with the shared client Auth user pool on `sandbox`.
 */
export function makeSandboxAuth(app: PyricAdminApp, sandbox: Sandbox): Auth {
  const store = storeFor(sandbox);

  const handle: Auth = {
    get app(): PyricAdminApp {
      return app;
    },

    createCustomToken(uid: string, developerClaims?: object): Promise<string> {
      assertAdminAppActive(app);
      assertCustomTokenArguments(uid, developerClaims);
      return mintSandboxCustomToken(app, getClock(sandbox).now(), uid, developerClaims);
    },

    verifyIdToken(idToken: string, checkRevoked = false): Promise<DecodedIdToken> {
      assertAdminAppActive(app);
      const verified = verifySandboxIdToken(idToken, {
        projectId: idTokenProjectId(app),
        nowMs: getClock(sandbox).now(),
      });
      if (!checkRevoked) return verified;
      return verified.then((decoded) =>
        assertNotRevokedOrDisabled(decoded, clientAccountStanding(sandbox, decoded.sub)),
      );
    },

    createUser(properties: CreateRequest): Promise<UserRecord> {
      assertAdminAppActive(app);
      if (properties.uid !== undefined) {
        const uidErr = invalidUid(properties.uid);
        if (uidErr !== null) return Promise.reject(uidErr);
      }
      if (properties.email !== undefined) {
        const emailErr = validateAdminEmail(properties.email);
        if (emailErr !== null) return Promise.reject(emailErr);
      }
      if (properties.password !== undefined) {
        const pwErr = validateAdminPassword(properties.password);
        if (pwErr !== null) return Promise.reject(pwErr);
      }
      const clientAuth = getClientAuth(sandbox);
      const existingUids = new Set(clientAuthSandbox.listUsers(clientAuth).map((u) => u.uid));
      const uid = properties.uid ?? store.mintUid(existingUids);
      const createInput: CreateRequest = {
        ...properties,
        uid,
      };
      try {
        const created = clientAuthSandbox.createUser(clientAuth, toSandboxCreateRequest(createInput));
        return Promise.resolve(fromAuthUserRecord(created));
      } catch (err) {
        return Promise.reject(translateAdminBackendError(err));
      }
    },

    getUser(uid: string): Promise<UserRecord> {
      assertAdminAppActive(app);
      const uidErr = invalidUid(uid);
      if (uidErr !== null) return Promise.reject(uidErr);
      const clientRecord = clientAuthSandbox.listUsers(getClientAuth(sandbox)).find((u) => u.uid === uid);
      if (clientRecord) {
        return Promise.resolve(fromAuthUserRecord(clientRecord));
      }
      return Promise.reject(
        new FirebaseAuthError('user-not-found', `pyric-admin/auth: getUser failed: no user with uid "${uid}"`),
      );
    },

    getUserByEmail(email: string): Promise<UserRecord> {
      assertAdminAppActive(app);
      const emailErr = validateAdminEmail(email);
      if (emailErr !== null) return Promise.reject(emailErr);
      const targetEmail = email.toLowerCase();
      const clientRecord = clientAuthSandbox
        .listUsers(getClientAuth(sandbox))
        .find((u) => u.email !== null && u.email.toLowerCase() === targetEmail);
      if (clientRecord) {
        return Promise.resolve(fromAuthUserRecord(clientRecord));
      }
      return Promise.reject(
        new FirebaseAuthError(
          'user-not-found',
          `pyric-admin/auth: getUserByEmail failed: no user with email "${email}"`,
        ),
      );
    },

    deleteUser(uid: string): Promise<void> {
      assertAdminAppActive(app);
      const uidErr = invalidUid(uid);
      if (uidErr !== null) return Promise.reject(uidErr);
      const clientAuth = getClientAuth(sandbox);
      const inClient = clientAuthSandbox.listUsers(clientAuth).some((u) => u.uid === uid);
      if (!inClient) {
        return Promise.reject(
          new FirebaseAuthError('user-not-found', `pyric-admin/auth: deleteUser failed: no user with uid "${uid}"`),
        );
      }
      clientAuthSandbox.deleteUser(clientAuth, uid);
      return Promise.resolve();
    },

    setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void> {
      assertAdminAppActive(app);
      const uidErr = invalidUid(uid);
      if (uidErr !== null) return Promise.reject(uidErr);
      try {
        assertValidCustomUserClaims(customUserClaims);
      } catch (e) {
        return Promise.reject(e);
      }
      const clientAuth = getClientAuth(sandbox);
      const inClient = clientAuthSandbox.listUsers(clientAuth).some((u) => u.uid === uid);
      if (!inClient) {
        return Promise.reject(
          new FirebaseAuthError(
            'user-not-found',
            `pyric-admin/auth: setCustomUserClaims failed: no user with uid "${uid}"`,
          ),
        );
      }
      let claimsMap: Record<string, unknown> = {};
      if (customUserClaims !== null) {
        claimsMap = customUserClaims as Record<string, unknown>;
      }
      clientAuthSandbox.updateUser(clientAuth, uid, { customClaims: claimsMap });
      return Promise.resolve();
    },

    updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
      assertAdminAppActive(app);
      try {
        const request = prepareSandboxUpdateRequest(uid, properties, notImplemented);
        const updated = clientAuthSandbox.updateUser(getClientAuth(sandbox), uid, request);
        return Promise.resolve(fromAuthUserRecord(updated));
      } catch (err) {
        return Promise.reject(translateAdminBackendError(err));
      }
    },
    getUserByPhoneNumber(): Promise<UserRecord> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getUserByPhoneNumber'));
    },
    getUserByProviderUid(): Promise<UserRecord> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getUserByProviderUid'));
    },
    getUsers(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getUsers'));
    },
    deleteUsers(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('deleteUsers'));
    },
    listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
      assertAdminAppActive(app);
      try {
        const records = clientAuthSandbox.listUsers(getClientAuth(sandbox));
        return Promise.resolve(paginateUserRecords(records, maxResults, pageToken));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    importUsers(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('importUsers'));
    },
    revokeRefreshTokens(uid: string): Promise<void> {
      assertAdminAppActive(app);
      const uidError = invalidUid(uid);
      if (uidError !== null) return Promise.reject(uidError);
      const standing = clientAccountStanding(sandbox, uid);
      const hasRecord = standing.kind === 'active' || standing.kind === 'disabled';
      if (!hasRecord) return Promise.reject(userNotFound());
      authAccountsFor(sandbox)?.revokeRefreshTokens(uid);
      return Promise.resolve();
    },
    createSessionCookie(): Promise<string> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('createSessionCookie'));
    },
    verifySessionCookie(): Promise<DecodedIdToken> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('verifySessionCookie'));
    },
    generatePasswordResetLink(): Promise<string> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('generatePasswordResetLink'));
    },
    generateEmailVerificationLink(): Promise<string> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('generateEmailVerificationLink'));
    },
    generateSignInWithEmailLink(): Promise<string> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('generateSignInWithEmailLink'));
    },
    generateVerifyAndChangeEmailLink(): Promise<string> {
      assertAdminAppActive(app);
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
