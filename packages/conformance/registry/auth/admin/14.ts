import { row } from './section.ts';

export default row({
  order: 160,
  featureKeys: [
    'Auth',
    'BaseAuth',
    'UserRecord',
    'UserInfo',
    'UserMetadata',
    'FirebaseAuthError',
    'AuthClientErrorCode',
    'UserRecord.multiFactor',
    'UserRecord.passwordHash',
    'UserRecord.passwordSalt',
  ],
  api: 'FirebaseAuthError / AuthClientErrorCode / nominal class exports and UserRecord.{multiFactor, passwordHash, passwordSalt}',
  behavior:
    'Exports `FirebaseAuthError` (`PrefixedFirebaseError` with `auth/` prefix, `hasCode`, `toJSON`, and `(info, message?)` constructor), `AuthClientErrorCode` (all 95 upstream entries), and the modeled nominal classes (`Auth`, `BaseAuth`, `UserRecord`, `UserMetadata`, `UserInfo`, plus `admin.auth.Auth`) across local and remote arms so thrown/rejected auth errors and returned handles/records satisfy `instanceof`. Constructors for unmodeled MFA and Identity Platform surfaces (`MultiFactorInfo`, `MultiFactorSettings`, `PhoneMultiFactorInfo`, `ProjectConfig`, `ProjectConfigManager`, `Tenant`, `TenantAwareAuth`, `TenantManager`) are not exported at runtime, returned `UserRecord` instances omit `multiFactor`, `passwordHash`, and `passwordSalt` (while storing `customClaims` as an own field), and `UserMetadata.toJSON()` omits unset `lastRefreshTime`.',
  status: 'diverged-documented',
  statusNote:
    'exports FirebaseAuthError, AuthClientErrorCode, Auth, BaseAuth, UserRecord, UserMetadata, and UserInfo; unmodeled MFA/Tenant/ProjectConfig classes are not exported and UserRecord/UserMetadata omit unmodeled passwordHash, passwordSalt, multiFactor, and unset lastRefreshTime keys',
  automation: 'oracle-backed',
  oracleObservations: ['admin-auth-runtime-exports-and-user-record-shape'],
  conformanceTests: [
    'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
    'packages/pyric-admin/test/auth/runtime-exports-parity.test.ts',
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
    'packages/cli/test/register/admin-auth-exports.test.ts',
    'test/apps/client-sdk-under-register/scenario.ts',
  ],
  evidence:
    'Production capture `admin-auth-runtime-exports-and-user-record-shape` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, plus export and UserRecord boundary checks across `@pyric/cli/register` and hosted Node app-scenario planes in `runtime-exports-parity.test.ts`, `admin-surface.test.ts`, `admin-auth-exports.test.ts`, and `client-sdk-under-register`.',
  risk: ['specific-field'],
  riskScore: 2,
  riskReasons: ['asserts runtime export and UserRecord property boundary'],
});
