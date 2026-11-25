import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import pyricAdmin from '../../../pyric-admin/src/index.js';
import { deleteApp, initializeApp } from '../../../pyric-admin/src/app/index.js';
import * as pyricAuthMod from '../../../pyric-admin/src/auth/index.js';
import {
  observeAdminAuthRuntimeExportsAndUserRecordShape,
  probe as runtimeExportsProbe,
  type AdminAuthRuntimeExportsSubject,
  type FirebaseAuthErrorConstructorLike,
} from '../../probes/auth-admin/admin-auth-runtime-exports-and-user-record-shape.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const PROBE_ID = 'admin-auth-runtime-exports-and-user-record-shape';

describe('linked auth-admin runtime exports and UserRecord shape probe', () => {
  test('registers on admin-auth with linked auth-admin#14 rowIds and pendingRowLink dropped', async () => {
    const loaded = await loadModularProbes('admin-auth');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(runtimeExportsProbe.rig).toBe('admin-auth');
    expect(runtimeExportsProbe.requires).toEqual(['admin-auth']);
    expect(runtimeExportsProbe.pendingRowLink).toBeUndefined();
    expect(runtimeExportsProbe.matrixRow).toBe('auth-admin#14');
    expect(runtimeExportsProbe.rowIds).toEqual(['auth-admin#14']);
    expect(runtimeExportsProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'admin-auth', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has(PROBE_ID)).toBe(true);

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'admin-auth',
      scriptPath: 'packages/conformance/src/admin-auth-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });

  test('executes observeAdminAuthRuntimeExportsAndUserRecordShape cleanly against pyric-admin/auth', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, 'staged-probe-unit');
    try {
      const auth = pyricAuthMod.getAuth(app);
      const rootNamespace = (pyricAdmin as { readonly auth?: { readonly Auth?: unknown } }).auth;
      const subject: AdminAuthRuntimeExportsSubject = {
        authModuleExports: pyricAuthMod as unknown as Record<string, unknown>,
        rootAdminAuthNamespace: rootNamespace,
        Auth: pyricAuthMod.Auth,
        BaseAuth: pyricAuthMod.BaseAuth,
        UserRecord: pyricAuthMod.UserRecord,
        UserMetadata: pyricAuthMod.UserMetadata,
        UserInfo: pyricAuthMod.UserInfo,
        FirebaseAuthError:
          pyricAuthMod.FirebaseAuthError as unknown as FirebaseAuthErrorConstructorLike,
        AuthErrorCode: pyricAuthMod.AuthErrorCode,
        authHandle: {
          createCustomToken: (uid, claims) => auth.createCustomToken(uid, claims),
          verifyIdToken: (idToken, checkRevoked) => auth.verifyIdToken(idToken, checkRevoked),
          createUser: (props) =>
            auth.createUser(props) as unknown as Promise<
              Awaited<ReturnType<AdminAuthRuntimeExportsSubject['authHandle']['createUser']>>
            >,
          getUser: (uid) =>
            auth.getUser(uid) as unknown as Promise<
              Awaited<ReturnType<AdminAuthRuntimeExportsSubject['authHandle']['getUser']>>
            >,
          listUsers: (max, token) =>
            auth.listUsers(max, token) as unknown as Promise<
              Awaited<ReturnType<AdminAuthRuntimeExportsSubject['authHandle']['listUsers']>>
            >,
          setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
        },
      };
      Object.setPrototypeOf(subject.authHandle, Object.getPrototypeOf(auth) as object);

      const observed = await observeAdminAuthRuntimeExportsAndUserRecordShape(
        subject,
        'unit-exports-probe',
      );
      expect(observed.moduleExports).toMatchObject({
        rootAdminAuthHasAuthClass: false,
        authExtendsBaseAuth: true,
        authClientErrorCodeCount: 96,
      });
      expect(observed.errorConstructorContract).toEqual({
        defaultCode: 'auth/user-not-found',
        defaultCodePrefix: 'auth',
        defaultName: 'Error',
        defaultMessage: 'There is no user record corresponding to the provided identifier.',
        defaultHasCodeMatch: true,
        defaultHasCodeMismatch: false,
        defaultToJson: {
          code: 'auth/user-not-found',
          message: 'There is no user record corresponding to the provided identifier.',
        },
        defaultOwnKeys: ['code', 'codePrefix'],
        overrideCode: 'auth/argument-error',
        overrideMessage: 'Explicit message override.',
        overrideToJson: {
          code: 'auth/argument-error',
          message: 'Explicit message override.',
        },
      });
      expect(observed.liveErrorInstanceOf).toEqual({
        syncEmptyCustomToken: {
          mode: 'sync-throw',
          isError: true,
          isFirebaseAuthError: true,
          name: 'Error',
          code: 'auth/argument-error',
        },
        syncNonStringIdToken: {
          mode: 'sync-throw',
          isError: true,
          isFirebaseAuthError: true,
          name: 'Error',
          code: 'auth/argument-error',
        },
        rejectedMissingGetUser: {
          mode: 'rejected',
          isError: true,
          isFirebaseAuthError: true,
          name: 'Error',
          code: 'auth/user-not-found',
        },
        rejectedMalformedIdToken: {
          mode: 'rejected',
          isError: true,
          isFirebaseAuthError: true,
          name: 'Error',
          code: 'auth/argument-error',
        },
        rejectedReservedCustomClaim: {
          mode: 'rejected',
          isError: true,
          isFirebaseAuthError: true,
          name: 'Error',
          code: 'auth/reserved-claim',
        },
      });
      expect(observed.handleAndRecordInstanceOf).toMatchObject({
        authIsAuth: true,
        authIsBaseAuth: true,
        createdIsUserRecord: true,
        fetchedIsUserRecord: true,
        listedIsUserRecord: true,
        metadataIsUserMetadata: true,
        providerInfoIsUserInfo: true,
      });
      expect(JSON.stringify(observed)).not.toContain('unit-exports-probe');
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });
});
