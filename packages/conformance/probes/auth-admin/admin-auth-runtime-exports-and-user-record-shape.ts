import type { CreateRequest, ListUsersResult, UserRecord } from 'firebase-admin/auth';
import type { Probe } from '../../rigs/types.ts';
import { withAdminAuthProbeSession } from '../../src/sdk-probe-runtime.ts';

interface AuthErrorInfoLike {
  readonly code: string;
  readonly message: string;
}

export interface FirebaseAuthErrorConstructorLike {
  new (info: AuthErrorInfoLike, message?: string): Error & {
    readonly code: string;
    readonly codePrefix: string;
    readonly errorInfo: AuthErrorInfoLike;
    hasCode(code: string): boolean;
    toJSON(): AuthErrorInfoLike;
  };
}

export interface AdminAuthRuntimeExportsSubject {
  readonly authModuleExports: Record<string, unknown>;
  readonly rootAdminAuthNamespace: { readonly Auth?: unknown };
  readonly Auth: abstract new (...args: never[]) => object;
  readonly BaseAuth: abstract new (...args: never[]) => object;
  readonly UserRecord: abstract new (...args: never[]) => object;
  readonly UserMetadata: abstract new (...args: never[]) => object;
  readonly UserInfo: abstract new (...args: never[]) => object;
  readonly FirebaseAuthError: FirebaseAuthErrorConstructorLike;
  readonly AuthClientErrorCode: Record<string, unknown>;
  readonly authHandle: {
    createCustomToken(uid: string, developerClaims?: object): Promise<string>;
    verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<unknown>;
    createUser(properties: CreateRequest & { uid: string }): Promise<UserRecord>;
    getUser(uid: string): Promise<UserRecord>;
    listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
    setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void>;
  };
}

interface CapturedErrorShape {
  readonly mode: 'sync-throw' | 'rejected' | 'resolved';
  readonly isError: boolean;
  readonly isFirebaseAuthError: boolean;
  readonly name: string | null;
  readonly code: string | null;
}

const BUILTIN_STATIC_KEYS = new Set(['length', 'name', 'prototype']);

function summarizeUserRecordFields(record: UserRecord): Record<string, unknown> {
  const rawRecord = record as unknown as Record<string, unknown>;
  const json = record.toJSON() as Record<string, unknown>;
  return {
    isUserRecordInstance: true,
    ownKeys: Object.keys(rawRecord).sort(),
    toJsonKeys: Object.keys(json).sort(),
    hasOwnPasswordHash: Object.hasOwn(rawRecord, 'passwordHash'),
    passwordHashType: typeof record.passwordHash,
    passwordHashNonEmptyString:
      typeof record.passwordHash === 'string' && record.passwordHash.length > 0,
    hasOwnPasswordSalt: Object.hasOwn(rawRecord, 'passwordSalt'),
    passwordSaltType: typeof record.passwordSalt,
    passwordSaltNonEmptyString:
      typeof record.passwordSalt === 'string' && record.passwordSalt.length > 0,
    hasOwnMultiFactor: Object.hasOwn(rawRecord, 'multiFactor'),
    multiFactorType: typeof record.multiFactor,
  };
}

function captureErrorOutcome(
  err: unknown,
  mode: 'sync-throw' | 'rejected',
  ErrCtor: FirebaseAuthErrorConstructorLike,
): CapturedErrorShape {
  const shaped = err as { code?: unknown; name?: unknown } | null;
  let code: string | null = null;
  let name: string | null = null;
  if (shaped !== null && typeof shaped === 'object') {
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    if (typeof shaped.name === 'string') {
      name = shaped.name;
    }
  }
  return {
    mode,
    isError: err instanceof Error,
    isFirebaseAuthError: err instanceof ErrCtor,
    name,
    code,
  };
}

async function captureCallError(
  invoke: () => unknown,
  ErrCtor: FirebaseAuthErrorConstructorLike,
): Promise<CapturedErrorShape> {
  let pending: unknown;
  try {
    pending = invoke();
  } catch (err) {
    return captureErrorOutcome(err, 'sync-throw', ErrCtor);
  }
  try {
    await pending;
    return {
      mode: 'resolved',
      isError: false,
      isFirebaseAuthError: false,
      name: null,
      code: null,
    };
  } catch (err) {
    return captureErrorOutcome(err, 'rejected', ErrCtor);
  }
}

async function findUserInListUsers(
  listUsers: (maxResults?: number, pageToken?: string) => Promise<ListUsersResult>,
  targetUids: ReadonlySet<string>,
): Promise<Map<string, UserRecord>> {
  const found = new Map<string, UserRecord>();
  let pageToken: string | undefined;
  for (;;) {
    const page = await listUsers(1000, pageToken);
    for (const user of page.users) {
      if (targetUids.has(user.uid)) {
        found.set(user.uid, user);
      }
    }
    if (found.size === targetUids.size || page.pageToken === undefined) {
      return found;
    }
    pageToken = page.pageToken;
  }
}

export async function observeAdminAuthRuntimeExportsAndUserRecordShape(
  subject: AdminAuthRuntimeExportsSubject,
  uidPrefix: string,
): Promise<Record<string, unknown>> {
  const exportKeys = Object.keys(subject.authModuleExports)
    .filter((key) => key !== '__esModule' && key !== 'default')
    .sort();
  const errorCodeKeys = Object.getOwnPropertyNames(subject.AuthClientErrorCode)
    .filter((key) => !BUILTIN_STATIC_KEYS.has(key))
    .sort();

  const ErrCtor = subject.FirebaseAuthError;
  const userNotFoundInfo = subject.AuthClientErrorCode.USER_NOT_FOUND as AuthErrorInfoLike;
  const invalidArgInfo = subject.AuthClientErrorCode.INVALID_ARGUMENT as AuthErrorInfoLike;
  const defaultErr = new ErrCtor(userNotFoundInfo);
  const overrideErr = new ErrCtor(invalidArgInfo, 'Explicit message override.');

  const passwordUid = `${uidPrefix}-pw`;
  const passwordlessUid = `${uidPrefix}-nopw`;
  const missingUid = `${uidPrefix}-missing`;

  const createdPasswordUser = await subject.authHandle.createUser({
    uid: passwordUid,
    email: `${passwordUid}@example.com`,
    password: 'probe-password-123',
    displayName: 'Probe User',
  });
  const createdPasswordlessUser = await subject.authHandle.createUser({
    uid: passwordlessUid,
    email: `${passwordlessUid}@example.com`,
  });

  const fetchedPasswordUser = await subject.authHandle.getUser(passwordUid);
  const fetchedPasswordlessUser = await subject.authHandle.getUser(passwordlessUid);
  const listedMap = await findUserInListUsers(
    (maxResults, pageToken) => subject.authHandle.listUsers(maxResults, pageToken),
    new Set([passwordUid, passwordlessUid]),
  );
  const listedPasswordUser = listedMap.get(passwordUid);
  const listedPasswordlessUser = listedMap.get(passwordlessUid);
  if (listedPasswordUser === undefined || listedPasswordlessUser === undefined) {
    throw new Error('Expected created probe users to appear in listUsers pagination');
  }

  const firstProviderInfo = fetchedPasswordUser.providerData[0];
  let providerInfoToJsonKeys: string[] = [];
  if (firstProviderInfo !== undefined) {
    providerInfoToJsonKeys = Object.keys(firstProviderInfo.toJSON()).sort();
  }

  const syncEmptyCustomToken = await captureCallError(
    () => subject.authHandle.createCustomToken(''),
    ErrCtor,
  );
  const syncNonStringIdToken = await captureCallError(
    () => subject.authHandle.verifyIdToken(123 as never),
    ErrCtor,
  );
  const rejectedMissingGetUser = await captureCallError(
    () => subject.authHandle.getUser(missingUid),
    ErrCtor,
  );
  const rejectedMalformedIdToken = await captureCallError(
    () => subject.authHandle.verifyIdToken('not-a-jwt'),
    ErrCtor,
  );
  const rejectedReservedCustomClaim = await captureCallError(
    () => subject.authHandle.setCustomUserClaims(passwordUid, { sub: 'reserved' }),
    ErrCtor,
  );

  return {
    moduleExports: {
      exportKeys,
      rootAdminAuthHasAuthClass: subject.rootAdminAuthNamespace.Auth === subject.Auth,
      authExtendsBaseAuth: Object.getPrototypeOf(subject.Auth) === subject.BaseAuth,
      authClientErrorCodeCount: errorCodeKeys.length,
    },
    errorConstructorContract: {
      defaultCode: defaultErr.code,
      defaultCodePrefix: defaultErr.codePrefix,
      defaultName: defaultErr.name,
      defaultMessage: defaultErr.message,
      defaultHasCodeMatch: defaultErr.hasCode('user-not-found'),
      defaultHasCodeMismatch: defaultErr.hasCode('argument-error'),
      defaultToJson: defaultErr.toJSON(),
      defaultOwnKeys: Object.keys(defaultErr).sort(),
      overrideCode: overrideErr.code,
      overrideMessage: overrideErr.message,
      overrideToJson: overrideErr.toJSON(),
    },
    liveErrorInstanceOf: {
      syncEmptyCustomToken,
      syncNonStringIdToken,
      rejectedMissingGetUser,
      rejectedMalformedIdToken,
      rejectedReservedCustomClaim,
    },
    handleAndRecordInstanceOf: {
      authIsAuth: subject.authHandle instanceof subject.Auth,
      authIsBaseAuth: subject.authHandle instanceof subject.BaseAuth,
      createdIsUserRecord: createdPasswordUser instanceof subject.UserRecord,
      fetchedIsUserRecord: fetchedPasswordUser instanceof subject.UserRecord,
      listedIsUserRecord: listedPasswordUser instanceof subject.UserRecord,
      metadataIsUserMetadata: fetchedPasswordUser.metadata instanceof subject.UserMetadata,
      providerInfoIsUserInfo: fetchedPasswordUser.providerData[0] instanceof subject.UserInfo,
      metadataToJsonKeys: Object.keys(fetchedPasswordUser.metadata.toJSON()).sort(),
      providerInfoToJsonKeys,
    },
    userRecordFieldPresence: {
      createdPasswordUser: summarizeUserRecordFields(createdPasswordUser),
      fetchedPasswordUser: summarizeUserRecordFields(fetchedPasswordUser),
      listedPasswordUser: summarizeUserRecordFields(listedPasswordUser),
      createdPasswordlessUser: summarizeUserRecordFields(createdPasswordlessUser),
      fetchedPasswordlessUser: summarizeUserRecordFields(fetchedPasswordlessUser),
      listedPasswordlessUser: summarizeUserRecordFields(listedPasswordlessUser),
    },
  };
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth'],
  matrixRow: 'auth-admin#14',
  rowIds: ['auth-admin#14'],
  description:
    'firebase-admin/auth runtime value exports, FirebaseAuthError and AuthClientErrorCode constructor/throw instanceof behavior, Auth/BaseAuth/UserRecord/UserMetadata/UserInfo prototype checks, and UserRecord.{passwordHash, passwordSalt, multiFactor} presence across createUser, getUser, and listUsers.',
  async observe(): Promise<Record<string, unknown>> {
    return withAdminAuthProbeSession(async ({ uidPrefix, adminAuth, createProbeUser }) => {
      const [rootAdminMod, authMod] = await Promise.all([
        import('firebase-admin'),
        import('firebase-admin/auth'),
      ]);
      const rootDefault = (rootAdminMod.default ?? rootAdminMod) as {
        readonly auth: { readonly Auth?: unknown };
      };
      return observeAdminAuthRuntimeExportsAndUserRecordShape(
        {
          authModuleExports: authMod as unknown as Record<string, unknown>,
          rootAdminAuthNamespace: rootDefault.auth,
          Auth: authMod.Auth as unknown as abstract new (...args: never[]) => object,
          BaseAuth: authMod.BaseAuth as unknown as abstract new (...args: never[]) => object,
          UserRecord: authMod.UserRecord as unknown as abstract new (...args: never[]) => object,
          UserMetadata: authMod.UserMetadata as unknown as abstract new (...args: never[]) => object,
          UserInfo: authMod.UserInfo as unknown as abstract new (...args: never[]) => object,
          FirebaseAuthError:
            authMod.FirebaseAuthError as unknown as FirebaseAuthErrorConstructorLike,
          AuthClientErrorCode: authMod.AuthClientErrorCode as unknown as Record<string, unknown>,
          authHandle: Object.setPrototypeOf(
            {
              createCustomToken: (uid: string, claims?: object) =>
                adminAuth.createCustomToken(uid, claims),
              verifyIdToken: (idToken: string, checkRevoked?: boolean) =>
                adminAuth.verifyIdToken(idToken, checkRevoked),
              createUser: (properties: CreateRequest & { uid: string }) =>
                createProbeUser(properties),
              getUser: (uid: string) => adminAuth.getUser(uid),
              listUsers: (maxResults?: number, pageToken?: string) =>
                adminAuth.listUsers(maxResults, pageToken),
              setCustomUserClaims: (uid: string, claims: object | null) =>
                adminAuth.setCustomUserClaims(uid, claims),
            },
            Object.getPrototypeOf(adminAuth) as object,
          ) as AdminAuthRuntimeExportsSubject['authHandle'],
        },
        uidPrefix,
      );
    });
  },
};
