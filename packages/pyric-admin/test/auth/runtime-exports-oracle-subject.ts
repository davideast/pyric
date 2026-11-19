import {
  observeAdminAuthRuntimeExportsAndUserRecordShape,
  type AdminAuthRuntimeExportsSubject,
  type FirebaseAuthErrorConstructorLike,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-runtime-exports-and-user-record-shape.ts';
import pyricAdmin from '../../src/index.js';
import * as pyricAuthMod from '../../src/auth/index.js';
import type { Auth } from '../../src/auth/index.js';

export function observeRuntimeExportsForAuth(
  auth: Auth,
  uidPrefix: string,
): Promise<Record<string, unknown>> {
  const authHandle: AdminAuthRuntimeExportsSubject['authHandle'] = {
    createCustomToken: (uid, claims) => auth.createCustomToken(uid, claims),
    verifyIdToken: (idToken, checkRevoked) => auth.verifyIdToken(idToken, checkRevoked),
    createUser: (properties) =>
      auth.createUser(properties) as unknown as Promise<
        Awaited<ReturnType<AdminAuthRuntimeExportsSubject['authHandle']['createUser']>>
      >,
    getUser: (uid) =>
      auth.getUser(uid) as unknown as Promise<
        Awaited<ReturnType<AdminAuthRuntimeExportsSubject['authHandle']['getUser']>>
      >,
    listUsers: (maxResults, pageToken) =>
      auth.listUsers(maxResults, pageToken) as unknown as Promise<
        Awaited<ReturnType<AdminAuthRuntimeExportsSubject['authHandle']['listUsers']>>
      >,
    setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
  };
  Object.setPrototypeOf(authHandle, Object.getPrototypeOf(auth) as object);
  const subject: AdminAuthRuntimeExportsSubject = {
    authModuleExports: pyricAuthMod as unknown as Record<string, unknown>,
    rootAdminAuthNamespace: pyricAdmin.auth,
    Auth: pyricAuthMod.Auth,
    BaseAuth: pyricAuthMod.BaseAuth,
    UserRecord: pyricAuthMod.UserRecord,
    UserMetadata: pyricAuthMod.UserMetadata,
    UserInfo: pyricAuthMod.UserInfo,
    FirebaseAuthError:
      pyricAuthMod.FirebaseAuthError as unknown as FirebaseAuthErrorConstructorLike,
    AuthClientErrorCode: pyricAuthMod.AuthClientErrorCode as unknown as Record<string, unknown>,
    authHandle,
  };
  return observeAdminAuthRuntimeExportsAndUserRecordShape(subject, uidPrefix);
}
