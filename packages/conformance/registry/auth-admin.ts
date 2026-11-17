import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilityTableBlock } from './types.ts';

const SECTION = 'firebase-admin `getAuth()` (`pyric-admin/auth`)';

const adminRow = defineRows({
  surface: 'auth-admin',
  defaults: {
    section: SECTION,
  },
});

const authAdminRows: CompatibilityRow[] = [
  adminRow({
    rowRef: '1',
    featureKeys: ['getAuth'],
    api: 'getAuth() (default app resolution and app/no-app)',
    behavior:
      'Calling `getAuth()` with no argument resolves the initialized `[DEFAULT]` `PyricAdminApp` to an `Auth` handle, and throws `FirebaseAppError` `app/no-app` with the upstream `[DEFAULT]` message when no default app exists.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: [
      'admin-app-accessors-resolve-default',
      'admin-app-no-app-error',
    ],
    conformanceTests: [
      'packages/pyric-admin/test/app/oracle-conformance.test.ts',
      'packages/pyric-admin/test/app/default-service-app.test.ts',
      'packages/pyric-admin/test/auth/auth-service.test.ts',
    ],
    evidence:
      'Production captures `admin-app-accessors-resolve-default` and `admin-app-no-app-error` (firebase-admin 13.10.0) replayed by `oracle-conformance.test.ts`, `default-service-app.test.ts`, and `auth-service.test.ts`.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts default-app resolution and app/no-app error code'],
  }),
  adminRow({
    rowRef: '1a',
    featureKeys: ['getAuth'],
    api: 'getAuth(app) (explicit app routing, post-deleteApp rejection, and uncached handle divergence)',
    behavior:
      'Routes `getAuth(app)` across in-process and remote worker sandboxes (`auth.app === app`), rejects non-`PyricAdminApp` inputs with `TypeError`, and rejects `getAuth(app)` after `deleteApp(app)` with `app/app-deleted`; unlike `firebase-admin/auth`, `getAuth(app)` constructs a fresh `Auth` wrapper per call (`getAuth(app) !== getAuth(app)`).',
    status: 'diverged-documented',
    statusNote:
      'getAuth(app) constructs a fresh Auth wrapper per call (getAuth(app) !== getAuth(app)) rather than caching one handle per app',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/auth/auth-service.test.ts',
      'packages/pyric-admin/test/app/registry.test.ts',
    ],
    evidence:
      'Pinned across local and remote arms in `auth-service.test.ts` and post-delete lifecycle checks in `registry.test.ts`.',
    risk: ['error-code', 'stateful'],
    riskScore: 2,
    riskReasons: ['asserts app brand check, app/app-deleted, and uncached wrapper behavior'],
  }),
  adminRow({
    rowRef: '2',
    featureKeys: ['Auth.createCustomToken'],
    api: 'auth.createCustomToken(uid, developerClaims?)',
    behavior:
      'Validates `uid` (non-empty string up to 128 chars) and `developerClaims` (plain non-null object free of reserved claims such as `aud`, `iss`, `sub`, `iat`, `exp`, while permitting `firebase`) synchronously with `auth/argument-error`, and mints an RS256 sandbox custom-token JWT exchangeable via `signInWithCustomToken`.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['auth-request-auth-per-sign-in'],
    conformanceTests: [
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
      'packages/pyric-admin/src/auth/custom-token-exchange.test.ts',
    ],
    evidence:
      'Production capture `auth-request-auth-per-sign-in` (`behavior.admin.createCustomToken*`) replayed by `oracle-admin-answers.test.ts`, plus end-to-end client exchange in `custom-token-exchange.test.ts`.',
    risk: ['error-code', 'specific-value'],
    riskScore: 4,
    riskReasons: ['asserts synchronous auth/argument-error checks', 'asserts custom-token JWT shape'],
  }),
  adminRow({
    rowRef: '3',
    featureKeys: ['Auth.verifyIdToken'],
    api: 'auth.verifyIdToken(idToken, checkRevoked?) (decoded claims, custom-token rejection, and disabled/deleted checks)',
    behavior:
      'Decodes standard and custom ID token claims (`uid === sub`, `auth_time`, `exp - iat`, `firebase.sign_in_provider`, `firebase.identities`), rejects custom tokens with `auth/argument-error`, resolves disabled users when `checkRevoked` is omitted or false, and with `checkRevoked: true` rejects disabled (`auth/user-disabled`) and deleted (`auth/user-not-found`) accounts.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['auth-request-auth-per-sign-in'],
    conformanceTests: [
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
      'packages/pyric-admin/src/auth/verify-id-token-claims.test.ts',
    ],
    evidence:
      'Production capture `auth-request-auth-per-sign-in` (`verifyIdTokenDecoded`, `verifyIdTokenOfCustomToken`, `verifyIdTokenNoCheckDisabled`, `verifyIdTokenCheckRevokedDisabled`, `verifyIdTokenCheckRevokedDeleted`) replayed by `oracle-admin-answers.test.ts` and `verify-id-token-claims.test.ts`.',
    risk: ['error-code', 'specific-field'],
    riskScore: 4,
    riskReasons: ['asserts decoded token claims', 'asserts custom-token and disabled/deleted checkRevoked error codes'],
  }),
  adminRow({
    rowRef: '3a',
    featureKeys: ['Auth.verifyIdToken'],
    api: 'auth.verifyIdToken(idToken, checkRevoked?) (signature, audience, expiry, and revocation-cutoff checks)',
    behavior:
      'Rejects malformed, tampered-signature, wrong-audience/issuer, and expired ID tokens with `auth/argument-error` or `auth/id-token-expired`, and with `checkRevoked: true` rejects tokens issued prior to the user revocation cutoff with `auth/id-token-revoked`.',
    status: 'conforms',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/auth/verify-token.test.ts',
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
    ],
    evidence:
      'Verified by `verify-token.test.ts` and `oracle-admin-answers.test.ts`; no standalone production capture records tampered/expired/wrong-audience or revocation-cutoff ID tokens.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts JWT signature/aud/exp validation and auth/id-token-revoked'],
  }),
  adminRow({
    rowRef: '4',
    featureKeys: ['Auth.revokeRefreshTokens'],
    api: 'auth.revokeRefreshTokens(uid)',
    behavior:
      'Advances the user revocation timestamp across local and remote arms so earlier ID tokens fail `verifyIdToken(token, true)` with `auth/id-token-revoked` and forced client token refreshes reject with `auth/user-token-expired`; rejects unknown UIDs with `auth/user-not-found`.',
    status: 'conforms',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence:
      'Verified by `oracle-admin-answers.test.ts`, `local-auth.test.ts`, and `remote-auth.test.ts`; no standalone production capture records `revokeRefreshTokens` directly.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts revocation cutoff and auth/id-token-revoked'],
  }),
  adminRow({
    rowRef: '5',
    featureKeys: ['Auth.createUser'],
    api: 'auth.createUser(properties)',
    behavior:
      'Creates a user in the shared client/admin identity store (generating a UID when omitted), validates UID, email (`auth/invalid-email`), and password length >= 6 (`auth/invalid-password`), and rejects duplicate UIDs (`auth/uid-already-exists`) or duplicate emails (`auth/email-already-exists`).',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['auth-request-auth-per-sign-in'],
    conformanceTests: [
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence:
      'Production capture `auth-request-auth-per-sign-in` (`behavior.admin.createUser*` and `freshPasswordUserRecord`) replayed by `oracle-admin-answers.test.ts`, `local-auth.test.ts`, and `remote-auth.test.ts`.',
    risk: ['error-code', 'stateful'],
    riskScore: 4,
    riskReasons: ['asserts validation and uniqueness error codes', 'asserts UserRecord shape'],
  }),
  adminRow({
    rowRef: '6',
    featureKeys: ['Auth.getUser', 'Auth.getUserByEmail', 'Auth.deleteUser'],
    api: 'auth.getUser(uid) / auth.getUserByEmail(email) / auth.deleteUser(uid)',
    behavior:
      'Retrieves `UserRecord` handles by UID or case-insensitive email and deletes existing accounts across local and remote arms; rejects missing accounts with `auth/user-not-found`.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['auth-request-auth-per-sign-in'],
    conformanceTests: [
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence:
      'Production capture `auth-request-auth-per-sign-in` (`getUserMissing`, `getUserByEmailMissing`, `getUserByEmailOtherCase`, `deleteUserMissing`) replayed by `oracle-admin-answers.test.ts`, `local-auth.test.ts`, and `remote-auth.test.ts`.',
    risk: ['error-code', 'stateful'],
    riskScore: 3,
    riskReasons: ['asserts case-insensitive email lookup and auth/user-not-found'],
  }),
  adminRow({
    rowRef: '7',
    featureKeys: ['Auth.setCustomUserClaims'],
    api: 'auth.setCustomUserClaims(uid, customUserClaims)',
    behavior:
      'Sets or clears (`null`) developer custom claims on an existing account, enforcing the 1000-character serialized payload limit (`auth/claims-too-large`), reserved claim names (`auth/reserved-claim`), and user existence (`auth/user-not-found`).',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['auth-request-auth-per-sign-in'],
    conformanceTests: [
      'packages/pyric-admin/src/auth/oracle-admin-answers.test.ts',
      'packages/pyric-admin/test/auth/validation.test.ts',
    ],
    evidence:
      'Production capture `auth-request-auth-per-sign-in` (`setCustomUserClaims1100`, `setCustomUserClaimsReserved`, `setCustomUserClaimsMissing`) replayed by `oracle-admin-answers.test.ts` and `validation.test.ts`.',
    risk: ['error-code', 'specific-value'],
    riskScore: 3,
    riskReasons: ['asserts 1000-char payload limit and reserved-claim rejections'],
  }),
  adminRow({
    rowRef: '8',
    featureKeys: ['Auth.updateUser'],
    api: 'auth.updateUser(uid, properties)',
    behavior:
      'Updates email, password, `emailVerified`, `displayName`, `photoURL`, `phoneNumber`, and `disabled` flags across local and remote arms; `multiFactor`, `providerToLink`, and `providersToUnlink` properties are not modeled and reject explicitly.',
    status: 'diverged-documented',
    statusNote:
      'profile, credential, and disabled fields update; multiFactor, providerToLink, and providersToUnlink reject as unimplemented',
    automation: 'unit-backed',
    conformanceTests: [
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
      'packages/pyric-admin/test/auth/validation.test.ts',
    ],
    evidence:
      'Pinned across local and remote arms in `local-auth.test.ts`, `remote-auth.test.ts`, and `validation.test.ts`.',
    risk: ['stateful'],
    riskScore: 2,
    riskReasons: ['asserts partial UpdateRequest field coverage'],
  }),
  adminRow({
    rowRef: '9',
    featureKeys: ['Auth.listUsers'],
    api: 'auth.listUsers(maxResults?, pageToken?)',
    behavior:
      'Lists `UserRecord` entries in pages up to `maxResults` (1..1000, default 1000) with exclusive UID keyset cursor pagination via `pageToken` across local and remote arms, advancing without skipping or duplicating surviving users when the last-returned or next-boundary user is deleted between pages.',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: ['admin-auth-listusers-deleted-cursor'],
    conformanceTests: [
      'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
      'packages/pyric-admin/test/auth/validation.test.ts',
    ],
    evidence:
      'Production capture `admin-auth-listusers-deleted-cursor` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, `local-auth.test.ts`, `remote-auth.test.ts`, and `validation.test.ts`.',
    risk: ['specific-value'],
    riskScore: 2,
    riskReasons: ['asserts page boundaries, deleted-cursor progression, and pageToken validation'],
  }),
  adminRow({
    rowRef: '10',
    featureKeys: [
      'Auth.getUserByPhoneNumber',
      'Auth.getUserByProviderUid',
      'Auth.getUsers',
      'Auth.deleteUsers',
      'Auth.importUsers',
    ],
    api: 'auth.getUserByPhoneNumber / getUserByProviderUid / getUsers / deleteUsers / importUsers',
    behavior:
      'Bulk user lookup, batch deletion, hash-imported user migration, and phone/provider-UID lookups are not implemented in `pyric-admin/auth` and reject explicitly.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Bulk user import/delete/lookup and phone/provider-UID queries are not yet implemented in pyric-admin/auth; calls reject explicitly.',
    conformanceTests: [
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
  }),
  adminRow({
    rowRef: '11',
    featureKeys: ['Auth.createSessionCookie', 'Auth.verifySessionCookie'],
    api: 'auth.createSessionCookie(idToken, options) / auth.verifySessionCookie(sessionCookie, checkRevoked?)',
    behavior:
      'HTTP session cookie minting and verification are not implemented in `pyric-admin/auth` and reject explicitly.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Session cookie minting and verification are not yet implemented in pyric-admin/auth; calls reject explicitly.',
    conformanceTests: [
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
  }),
  adminRow({
    rowRef: '12',
    featureKeys: [
      'Auth.generatePasswordResetLink',
      'Auth.generateEmailVerificationLink',
      'Auth.generateSignInWithEmailLink',
      'Auth.generateVerifyAndChangeEmailLink',
    ],
    api: 'auth.generatePasswordResetLink / generateEmailVerificationLink / generateSignInWithEmailLink / generateVerifyAndChangeEmailLink',
    behavior:
      'Out-of-band email action link generators are not implemented in `pyric-admin/auth` and reject explicitly.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Out-of-band email action link generators are not yet implemented in pyric-admin/auth; calls reject explicitly.',
    conformanceTests: [
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
  }),
  adminRow({
    rowRef: '13',
    featureKeys: [
      'Auth.tenantManager',
      'Auth.projectConfigManager',
      'Auth.createProviderConfig',
      'Auth.getProviderConfig',
      'Auth.listProviderConfigs',
      'Auth.updateProviderConfig',
      'Auth.deleteProviderConfig',
    ],
    api: 'auth.tenantManager / projectConfigManager / *ProviderConfig',
    behavior:
      'Identity Platform tenant administration, project configuration, and SAML/OIDC provider config CRUD are not implemented in `pyric-admin/auth` and throw or reject explicitly.',
    status: 'unsupported',
    automation: 'unsupported',
    exceptionReason:
      'Identity Platform tenant and IdP configuration admin managers are not modeled in the local sandbox; calls throw or reject explicitly.',
    conformanceTests: [
      'packages/pyric-admin/test/auth/local-auth.test.ts',
      'packages/pyric-admin/test/auth/remote-auth.test.ts',
    ],
    evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
  }),
  adminRow({
    rowRef: '14',
    featureKeys: [
      'FirebaseAuthError',
      'AuthClientErrorCode',
      'UserRecord.multiFactor',
      'UserRecord.passwordHash',
      'UserRecord.passwordSalt',
    ],
    api: 'FirebaseAuthError / AuthClientErrorCode / nominal class exports and UserRecord.{multiFactor, passwordHash, passwordSalt}',
    behavior:
      'Errors thrown by `pyric-admin/auth` carry the upstream `code` and `message` strings on standard `Error` instances rather than exporting `FirebaseAuthError`, `AuthClientErrorCode`, or nominal class constructors (`Auth`, `BaseAuth`, `UserRecord`, `UserInfo`, `UserMetadata`, `Tenant*`), and returned `UserRecord` objects omit `multiFactor`, `passwordHash`, and `passwordSalt`.',
    status: 'diverged-documented',
    statusNote:
      'FirebaseAuthError, AuthClientErrorCode, and nominal class constructors are not exported at runtime; UserRecord omits multiFactor, passwordHash, and passwordSalt',
    automation: 'unit-backed',
    conformanceTests: ['packages/pyric-admin/test/surface/admin-surface.test.ts'],
    evidence:
      'Allowlisted and verified against the installed `firebase-admin/auth` surface in `admin-surface.test.ts`.',
    risk: ['specific-field'],
    riskScore: 2,
    riskReasons: ['asserts runtime export and UserRecord property boundary'],
  }),
];

export const authAdminBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix:
    '## `pyric-admin/auth`: Admin Auth user management and token verification\n\nThe admin Auth plane (surface `auth-admin`), mirroring `firebase-admin/auth` across in-process and remote worker sandboxes.\n',
  rows: authAdminRows,
};
