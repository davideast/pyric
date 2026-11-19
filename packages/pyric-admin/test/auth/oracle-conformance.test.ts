import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  getAuth as getClientAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithCustomToken,
} from 'pyric/auth';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getClock, SANDBOX_PROJECT_ID } from 'pyric/sandbox/internal';
import { createObservationGate } from '../../../../packages/conformance/src/observation-gate.ts';
import {
  observeGetAuthAppLifecycleFor,
  type GetAuthAppLifecycleSubject,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-getauth-app-lifecycle.ts';
import {
  observeListUsersDeletedCursor,
  type AdminAuthCursorSubject,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-listusers-deleted-cursor.ts';
import {
  observeRevokeRefreshTokens,
  type RevokeRefreshTokensSubject,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-revoke-refresh-tokens.ts';
import {
  observeUpdateUserFields,
  type AdminUpdateUserSubject,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-update-user-fields.ts';
import {
  observeVerifyIdTokenErrors,
  type VerifyIdTokenErrorsSubject,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-verify-id-token-errors.ts';
import { observeRuntimeExportsForAuth } from './runtime-exports-oracle-subject.js';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getAuth, type Auth } from '../../src/auth/index.js';
import { createWorkerBridgeRemoteAuth } from './worker-bridge-helper.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'conformance',
  'observations',
  'auth-admin',
);

const authAdminObsGate = createObservationGate({
  dir: OBS_DIR,
  match: (file) => file.startsWith('admin-auth-'),
});

function toCursorSubject(auth: Auth): AdminAuthCursorSubject {
  return {
    async createUser(uid: string): Promise<void> {
      await auth.createUser({ uid });
    },
    async deleteUser(uid: string): Promise<void> {
      await auth.deleteUser(uid);
    },
    async listUsers(maxResults: number, pageToken?: string) {
      return auth.listUsers(maxResults, pageToken);
    },
  };
}

function toLifecycleSubject(
  sandboxOrRemote: Sandbox,
): GetAuthAppLifecycleSubject<PyricAdminApp, Auth> {
  return {
    initializeNamedApp(name: string): PyricAdminApp {
      return initializeApp({ sandbox: sandboxOrRemote }, name);
    },
    getAuth(app: PyricAdminApp): Auth {
      return getAuth(app);
    },
    deleteApp(app: PyricAdminApp): Promise<void> {
      return deleteApp(app);
    },
  };
}

async function mintSandboxClientIdToken(
  clientSandbox: Sandbox,
  adminAuth: Auth,
  uid: string,
): Promise<string> {
  await adminAuth.createUser({ uid });
  const customToken = await adminAuth.createCustomToken(uid);
  const clientAuth = getClientAuth(clientSandbox);
  await setPersistence(clientAuth, inMemoryPersistence);
  const cred = await signInWithCustomToken(clientAuth, customToken);
  return cred.user.getIdToken();
}

function toRevokeSubject(clientSandbox: Sandbox, adminAuth: Auth): RevokeRefreshTokensSubject {
  return {
    async createUser(uid: string): Promise<void> {
      await adminAuth.createUser({ uid });
    },
    async createCustomToken(uid: string): Promise<string> {
      return adminAuth.createCustomToken(uid);
    },
    async getUser(uid: string): Promise<{ tokensValidAfterTime?: string }> {
      const record = await adminAuth.getUser(uid);
      return { tokensValidAfterTime: record.tokensValidAfterTime };
    },
    async revokeRefreshTokens(uid: string): Promise<unknown> {
      return adminAuth.revokeRefreshTokens(uid);
    },
    async verifyIdToken(idToken: string, checkRevoked?: boolean) {
      return adminAuth.verifyIdToken(idToken, checkRevoked);
    },
    async signInClientWithCustomToken(customToken: string) {
      const clientAuth = getClientAuth(clientSandbox);
      await setPersistence(clientAuth, inMemoryPersistence);
      const cred = await signInWithCustomToken(clientAuth, customToken);
      return {
        async getIdToken(forceRefresh = false): Promise<string> {
          return cred.user.getIdToken(forceRefresh);
        },
        async dispose(): Promise<void> {},
      };
    },
    async waitForNextUtcSecondAfter(authTimeSec: number): Promise<void> {
      getClock(clientSandbox).set((authTimeSec + 2) * 1000);
    },
  };
}

function toUpdateUserSubject(adminAuth: Auth): AdminUpdateUserSubject {
  return {
    createUser: (properties) => adminAuth.createUser(properties),
    updateUser: (uid, properties) => adminAuth.updateUser(uid, properties),
    getUser: (uid) => adminAuth.getUser(uid),
  };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('oracle conformance (auth-admin)', () => {
  it('admin-auth-getauth-app-lifecycle (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-getauth-app-lifecycle',
    );

    const localSandbox = initializeSandbox();
    try {
      const localActual = await observeGetAuthAppLifecycleFor(toLifecycleSubject(localSandbox));
      expect({ ...localActual }).toEqual(expected);
    } finally {
      localSandbox.dispose();
    }

    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-lifecycle-seed');
    try {
      const remoteActual = await observeGetAuthAppLifecycleFor(
        toLifecycleSubject(remoteStack.remote),
      );
      expect({ ...remoteActual }).toEqual(expected);
    } finally {
      remoteStack.dispose();
    }
  });

  it('admin-auth-verify-id-token-errors (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-verify-id-token-errors',
    );

    const localSandbox = initializeSandbox();
    try {
      const primaryLocal = getAuth(
        initializeApp({ sandbox: localSandbox }, 'oracle-verify-local-primary'),
      );
      const foreignLocal = getAuth(
        initializeApp(
          { sandbox: localSandbox, projectId: 'another-project' },
          'oracle-verify-local-foreign',
        ),
      );
      const localToken = await mintSandboxClientIdToken(
        localSandbox,
        primaryLocal,
        'oracle-verify-local-uid',
      );
      const localSubject: VerifyIdTokenErrorsSubject = {
        projectId: SANDBOX_PROJECT_ID,
        subjectUid: 'oracle-verify-local-uid',
        validIdToken: localToken,
        verifyPrimary: (idToken) => primaryLocal.verifyIdToken(idToken),
        verifyForeignProject: (idToken) => foreignLocal.verifyIdToken(idToken),
      };
      expect(await observeVerifyIdTokenErrors(localSubject)).toEqual(expected);
    } finally {
      localSandbox.dispose();
    }

    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-verify-remote-primary');
    try {
      const foreignRemote = getAuth(
        initializeApp(
          { sandbox: remoteStack.remote, projectId: 'another-project' },
          'oracle-verify-remote-foreign',
        ),
      );
      const remoteToken = await mintSandboxClientIdToken(
        remoteStack.sandbox,
        remoteStack.auth,
        'oracle-verify-remote-uid',
      );
      const remoteSubject: VerifyIdTokenErrorsSubject = {
        projectId: SANDBOX_PROJECT_ID,
        subjectUid: 'oracle-verify-remote-uid',
        validIdToken: remoteToken,
        verifyPrimary: (idToken) => remoteStack.auth.verifyIdToken(idToken),
        verifyForeignProject: (idToken) => foreignRemote.verifyIdToken(idToken),
      };
      expect(await observeVerifyIdTokenErrors(remoteSubject)).toEqual(expected);
    } finally {
      remoteStack.dispose();
    }
  });

  it('admin-auth-revoke-refresh-tokens (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-revoke-refresh-tokens',
    );

    const localSandbox = initializeSandbox();
    getClock(localSandbox).set(Date.parse('2026-06-01T12:00:00.250Z'));
    try {
      const localAuth = getAuth(
        initializeApp({ sandbox: localSandbox }, 'oracle-revoke-local'),
      );
      const localActual = await observeRevokeRefreshTokens(
        toRevokeSubject(localSandbox, localAuth),
        'oracle-local-revoke',
      );
      expect(localActual).toEqual(expected);
    } finally {
      localSandbox.dispose();
    }

    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-revoke-remote');
    getClock(remoteStack.sandbox).set(Date.parse('2026-06-01T12:00:00.250Z'));
    try {
      const remoteActual = await observeRevokeRefreshTokens(
        toRevokeSubject(remoteStack.sandbox, remoteStack.auth),
        'oracle-remote-revoke',
      );
      expect(remoteActual).toEqual(expected);
    } finally {
      remoteStack.dispose();
    }
  });

  it('admin-auth-update-user-fields (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-update-user-fields',
    );

    const localSandbox = initializeSandbox();
    try {
      const localAuth = getAuth(
        initializeApp({ sandbox: localSandbox }, 'oracle-update-local'),
      );
      const localActual = await observeUpdateUserFields(
        toUpdateUserSubject(localAuth),
        'oracle-local-update',
      );
      expect(localActual).toEqual(expected);
    } finally {
      localSandbox.dispose();
    }

    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-update-remote');
    try {
      const remoteActual = await observeUpdateUserFields(
        toUpdateUserSubject(remoteStack.auth),
        'oracle-remote-update',
      );
      expect(remoteActual).toEqual(expected);
    } finally {
      remoteStack.dispose();
    }
  });

  it('admin-auth-listusers-deleted-cursor (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-listusers-deleted-cursor',
    );

    const localAuth = getAuth(
      initializeApp({ sandbox: initializeSandbox() }, 'oracle-auth-admin-local'),
    );
    const localActual = await observeListUsersDeletedCursor(
      toCursorSubject(localAuth),
      'oracle-local-cursor',
    );
    expect(localActual.deleteLastReturnedUser).toEqual(expected.deleteLastReturnedUser);
    expect(localActual.deleteNextBoundaryUser).toEqual(expected.deleteNextBoundaryUser);

    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-auth-admin-remote');
    try {
      const remoteActual = await observeListUsersDeletedCursor(
        toCursorSubject(remoteStack.auth),
        'oracle-remote-cursor',
      );
      expect(remoteActual.deleteLastReturnedUser).toEqual(expected.deleteLastReturnedUser);
      expect(remoteActual.deleteNextBoundaryUser).toEqual(expected.deleteNextBoundaryUser);
    } finally {
      remoteStack.dispose();
    }
  });

  it('admin-auth-runtime-exports-and-user-record-shape (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-runtime-exports-and-user-record-shape',
    );

    let localActual: Record<string, unknown>;
    const localSandbox = initializeSandbox();
    try {
      const localAuth = getAuth(
        initializeApp({ sandbox: localSandbox }, 'oracle-exports-local'),
      );
      localActual = await observeRuntimeExportsForAuth(localAuth, 'oracle-local-exports');
    } finally {
      localSandbox.dispose();
    }

    let remoteActual: Record<string, unknown>;
    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-exports-remote');
    try {
      remoteActual = await observeRuntimeExportsForAuth(remoteStack.auth, 'oracle-remote-exports');
    } finally {
      remoteStack.dispose();
    }

    expect(remoteActual).toEqual(localActual);
    expect(localActual.errorConstructorContract).toEqual(expected.errorConstructorContract);
    expect(localActual.liveErrorInstanceOf).toEqual(expected.liveErrorInstanceOf);

    const actualExports = localActual.moduleExports as Record<string, unknown>;
    const expectedExports = expected.moduleExports as Record<string, unknown>;
    expect({
      rootAdminAuthHasAuthClass: actualExports.rootAdminAuthHasAuthClass,
      authExtendsBaseAuth: actualExports.authExtendsBaseAuth,
      authClientErrorCodeCount: actualExports.authClientErrorCodeCount,
    }).toEqual({
      rootAdminAuthHasAuthClass: expectedExports.rootAdminAuthHasAuthClass,
      authExtendsBaseAuth: expectedExports.authExtendsBaseAuth,
      authClientErrorCodeCount: expectedExports.authClientErrorCodeCount,
    });
    // auth-admin#14 divergence pin: pyric-admin/auth exports the 8 modeled symbols and
    // omits the 8 unmodeled MFA, Tenant, and ProjectConfig constructors.
    expect({
      pyric: actualExports.exportKeys,
      production: expectedExports.exportKeys,
    }).toEqual({
      pyric: [
        'Auth',
        'AuthClientErrorCode',
        'BaseAuth',
        'FirebaseAuthError',
        'UserInfo',
        'UserMetadata',
        'UserRecord',
        'getAuth',
      ],
      production: [
        'Auth',
        'AuthClientErrorCode',
        'BaseAuth',
        'FirebaseAuthError',
        'MultiFactorInfo',
        'MultiFactorSettings',
        'PhoneMultiFactorInfo',
        'ProjectConfig',
        'ProjectConfigManager',
        'Tenant',
        'TenantAwareAuth',
        'TenantManager',
        'UserInfo',
        'UserMetadata',
        'UserRecord',
        'getAuth',
      ],
    });

    const actualHandles = localActual.handleAndRecordInstanceOf as Record<string, unknown>;
    const expectedHandles = expected.handleAndRecordInstanceOf as Record<string, unknown>;
    expect({
      authIsAuth: actualHandles.authIsAuth,
      authIsBaseAuth: actualHandles.authIsBaseAuth,
      createdIsUserRecord: actualHandles.createdIsUserRecord,
      fetchedIsUserRecord: actualHandles.fetchedIsUserRecord,
      listedIsUserRecord: actualHandles.listedIsUserRecord,
      metadataIsUserMetadata: actualHandles.metadataIsUserMetadata,
      providerInfoIsUserInfo: actualHandles.providerInfoIsUserInfo,
      providerInfoToJsonKeys: actualHandles.providerInfoToJsonKeys,
    }).toEqual({
      authIsAuth: expectedHandles.authIsAuth,
      authIsBaseAuth: expectedHandles.authIsBaseAuth,
      createdIsUserRecord: expectedHandles.createdIsUserRecord,
      fetchedIsUserRecord: expectedHandles.fetchedIsUserRecord,
      listedIsUserRecord: expectedHandles.listedIsUserRecord,
      metadataIsUserMetadata: expectedHandles.metadataIsUserMetadata,
      providerInfoIsUserInfo: expectedHandles.providerInfoIsUserInfo,
      providerInfoToJsonKeys: expectedHandles.providerInfoToJsonKeys,
    });
    expect({
      pyric: actualHandles.metadataToJsonKeys,
      production: expectedHandles.metadataToJsonKeys,
    }).toEqual({
      pyric: ['creationTime', 'lastSignInTime'],
      production: ['creationTime', 'lastRefreshTime', 'lastSignInTime'],
    });

    const actualPresence = localActual.userRecordFieldPresence as Record<
      string,
      Record<string, unknown>
    >;
    const expectedPresence = expected.userRecordFieldPresence as Record<
      string,
      Record<string, unknown>
    >;
    const recordSamples = [
      'createdPasswordUser',
      'fetchedPasswordUser',
      'listedPasswordUser',
      'createdPasswordlessUser',
      'fetchedPasswordlessUser',
      'listedPasswordlessUser',
    ] as const;
    for (const sample of recordSamples) {
      const actualSample = actualPresence[sample];
      const expectedSample = expectedPresence[sample];
      if (actualSample === undefined || expectedSample === undefined) {
        throw new Error(`Missing userRecordFieldPresence sample: ${sample}`);
      }
      expect({
        isUserRecordInstance: actualSample.isUserRecordInstance,
        passwordHashType: actualSample.passwordHashType,
        passwordHashNonEmptyString: actualSample.passwordHashNonEmptyString,
        passwordSaltType: actualSample.passwordSaltType,
        passwordSaltNonEmptyString: actualSample.passwordSaltNonEmptyString,
        hasOwnMultiFactor: actualSample.hasOwnMultiFactor,
        multiFactorType: actualSample.multiFactorType,
      }).toEqual({
        isUserRecordInstance: expectedSample.isUserRecordInstance,
        passwordHashType: expectedSample.passwordHashType,
        passwordHashNonEmptyString: expectedSample.passwordHashNonEmptyString,
        passwordSaltType: expectedSample.passwordSaltType,
        passwordSaltNonEmptyString: expectedSample.passwordSaltNonEmptyString,
        hasOwnMultiFactor: expectedSample.hasOwnMultiFactor,
        multiFactorType: expectedSample.multiFactorType,
      });
      // auth-admin#14 divergence pin: UserRecord omits unmodeled passwordHash and
      // passwordSalt own properties and stores customClaims as an own property.
      expect({
        pyric: {
          hasOwnPasswordHash: actualSample.hasOwnPasswordHash,
          hasOwnPasswordSalt: actualSample.hasOwnPasswordSalt,
          ownKeys: actualSample.ownKeys,
          toJsonKeys: actualSample.toJsonKeys,
        },
        production: {
          hasOwnPasswordHash: expectedSample.hasOwnPasswordHash,
          hasOwnPasswordSalt: expectedSample.hasOwnPasswordSalt,
          ownKeys: expectedSample.ownKeys,
          toJsonKeys: expectedSample.toJsonKeys,
        },
      }).toEqual({
        pyric: {
          hasOwnPasswordHash: false,
          hasOwnPasswordSalt: false,
          ownKeys: [
            'customClaims',
            'disabled',
            'displayName',
            'email',
            'emailVerified',
            'metadata',
            'phoneNumber',
            'photoURL',
            'providerData',
            'tenantId',
            'tokensValidAfterTime',
            'uid',
          ],
          toJsonKeys: [
            'customClaims',
            'disabled',
            'displayName',
            'email',
            'emailVerified',
            'metadata',
            'phoneNumber',
            'photoURL',
            'providerData',
            'tenantId',
            'tokensValidAfterTime',
            'uid',
          ],
        },
        production: {
          hasOwnPasswordHash: true,
          hasOwnPasswordSalt: true,
          ownKeys: [
            'disabled',
            'displayName',
            'email',
            'emailVerified',
            'metadata',
            'passwordHash',
            'passwordSalt',
            'phoneNumber',
            'photoURL',
            'providerData',
            'tenantId',
            'tokensValidAfterTime',
            'uid',
          ],
          toJsonKeys: [
            'customClaims',
            'disabled',
            'displayName',
            'email',
            'emailVerified',
            'metadata',
            'passwordHash',
            'passwordSalt',
            'phoneNumber',
            'photoURL',
            'providerData',
            'tenantId',
            'tokensValidAfterTime',
            'uid',
          ],
        },
      });
    }
  });

  it('completeness: every observations/auth-admin/ capture is asserted', () => {
    const report = authAdminObsGate.report();
    expect(report.committed.length).toBe(6);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
