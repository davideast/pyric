---
title: "API reference: pyric-admin/auth"
navLabel: "API reference"
group: "pyric-admin / auth"
section: "Reference"
order: 183
---
# API reference: `pyric-admin/auth`

Exact signatures of every public export, plus the per-arm method matrix for the `Auth` handle. The package's whole story is which arm supports what, so every method below names its arms.

The three arms:

- **prod**: the app was initialized with `{ credential }` (or ambient with `PYRIC_SANDBOX` unset). `getAuth` returns `firebase-admin/auth`'s production `Auth` unchanged. Every method, tenant manager, and provider config works exactly as firebase-admin documents it. Nothing below applies to prod.
- **local**: the app carries an in-process `Sandbox`. Users live in an in-memory store keyed off the sandbox; `sandbox.reset()` wipes it.
- **remote**: the app carries a remote-branded sandbox (a Node handle onto the browser-hosted worker sandbox). User CRUD relays over the worker channel into the one user pool the browser app, Studio, and agents share. Mutations emit auth `SandboxEvent`s in the worker.

---

## Initialization

### `getAuth(app?)`
```ts
function getAuth(app?: PyricAdminApp): Auth;
```
Return an `Auth` handle for the given app, or for the `'[DEFAULT]'` app when called with no argument (mirrors firebase-admin's no-arg `getAuth()`; throws `app/no-app` when nothing is initialized). Dispatch reads the brand symbol on the handle:

- prod app: delegates to `firebase-admin/auth`'s `getAuth(app.adminApp)`. The firebase-admin import is deferred to call time, so sandbox-only consumers don't pay its initialization cost.
- sandbox app with a remote-branded sandbox: returns the remote relay handle.
- sandbox app (local): returns the in-memory handle. Repeat calls for the same sandbox share the store, so writes are visible across handles.

Throws `TypeError` for a value with no `ADMIN_APP_TARGET` brand, or a brand value the dispatch table doesn't know.

---

## Tokens (local and remote, identical)

Token handling is stateless string transformation, shared byte for byte by both sandbox arms. A token minted against either arm verifies against the other.

**Sandbox tokens are not real JWTs.** They are deterministic strings with no signature. They round-trip through this same sandbox backend and are rejected by every other token verifier. Never send one to a real Firebase service.

### `Auth.createCustomToken(uid, developerClaims?)`
```ts
createCustomToken(uid: string, developerClaims?: object): Promise<string>;
```
Arms: local, remote. Mints `` `${SANDBOX_TOKEN_PREFIX}:${uid}:${JSON.stringify(claims ?? {})}` ``. No signing, no expiry.

### `Auth.verifyIdToken(idToken, checkRevoked?)`
```ts
verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
```
Arms: local, remote. Parses tokens minted by `createCustomToken` and rejects anything else, including real JWTs. Returns a `DecodedIdToken`-shaped object: `aud` and `iss` are `'pyric-sandbox'`, `sub` and `uid` are the token's uid, time fields are now (`exp` is now plus 3600 seconds), `firebase.sign_in_provider` is `'custom'`, and the developer claims are spread onto the result so `decoded.role` reads the same way it does in production. `checkRevoked` is accepted and ignored (sandbox tokens have no revocation state).

### `SANDBOX_TOKEN_PREFIX`
```ts
const SANDBOX_TOKEN_PREFIX = 'pyric-sandbox-custom';
```
The token format's prefix, exported so tests can lock the shape. Layout: `pyric-sandbox-custom:${uid}:${jsonClaims}`. `verifyIdToken` splits on the first two colons only, so JSON claims containing colons round-trip losslessly.

---

## User management

### `Auth.createUser(properties)`
```ts
createUser(properties: CreateRequest): Promise<UserRecord>;
```
Arms: local, remote.

- Local: stores a `UserRecord` in the in-memory map. Auto-generates a uid of the form `pyric-sandbox-<20-digit counter>` when none is supplied. A supplied uid that already exists rejects. Defaults match upstream: `emailVerified: false`, `disabled: false`, empty `providerData`, `tenantId: null`, metadata with sandbox-current timestamps.
- Remote: relays the worker's `auth.adminCreateUser` op. Uid conflicts, invalid emails, and weak passwords reject with the worker backend's `auth/*` error. `multiFactor` is not modeled; upstream `null` ("clear") fields are treated as unset, since a fresh user has nothing to clear.

### `Auth.getUser(uid)` / `Auth.getUserByEmail(email)`
```ts
getUser(uid: string): Promise<UserRecord>;
getUserByEmail(email: string): Promise<UserRecord>;
```
Arms: local, remote. Rejects with a user-not-found message on a miss.

- Local: map lookup by uid; linear scan for email. Sandbox-scale data only.
- Remote: both go through `auth.listUsers` plus a client-side filter. The worker protocol has no dedicated single-lookup op; O(n) over the wire is fine at sandbox scale.

### `Auth.deleteUser(uid)`
```ts
deleteUser(uid: string): Promise<void>;
```
Arms: local, remote. Rejects on a missing uid, matching upstream's strict delete contract. Remote relays `auth.adminDeleteUser`.

### `Auth.setCustomUserClaims(uid, customUserClaims)`
```ts
setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void>;
```
Arms: local, remote. Replaces the stored `customClaims`; `null` clears them (upstream contract). Remote relays `auth.adminUpdateUser` with a whole-map `customClaims` replacement.

### `Auth.updateUser(uid, properties)`
```ts
updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
```
Arms: **remote only**. The local arm throws the not-implemented error.

Remote relays `auth.adminUpdateUser` for the fields the worker models: `displayName`, `email`, `password`, `disabled`, `emailVerified`. Fields it cannot express throw rather than silently dropping a requested change: `photoURL`, `phoneNumber`, `multiFactor`, `providerToLink`, `providersToUnlink`.

### `Auth.listUsers(maxResults?, pageToken?)`
```ts
listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
```
Arms: **remote only**. The local arm throws the not-implemented error.

Remote relays `auth.listUsers`. `maxResults` is honored by slicing; `pageToken` is accepted and ignored, and the result never sets one, because the whole pool fits one page at sandbox scale.

---

## Everything else throws (local and remote)

Every other method on the `Auth` surface throws an `Error` whose message names the method and the arm:
```
pyric-admin/auth: <method> is not implemented in pyric-admin/auth sandbox backend
pyric-admin/auth: <method> is not implemented in pyric-admin/auth remote sandbox backend
```
The full list, by area:

| Area | Methods |
|---|---|
| Lookups | `getUserByPhoneNumber`, `getUserByProviderUid` |
| Bulk operations | `getUsers`, `deleteUsers`, `importUsers`, `listUsers` (local arm only; works on remote) |
| Updates | `updateUser` (local arm only; works on remote) |
| Revocation | `revokeRefreshTokens` |
| Session cookies | `createSessionCookie`, `verifySessionCookie` |
| Action codes | `generatePasswordResetLink`, `generateEmailVerificationLink`, `generateSignInWithEmailLink`, `generateVerifyAndChangeEmailLink` |
| Identity providers | `createProviderConfig`, `getProviderConfig`, `listProviderConfigs`, `updateProviderConfig`, `deleteProviderConfig` |
| Managers | `tenantManager`, `projectConfigManager` (throwing getters) |
| Handle | the `auth.app` getter |

Multi-factor: `UserRecord.multiFactor` is always `undefined` on the sandbox arms; MFA enrollment is unsupported.

All of these work on the prod arm, which is the unmodified firebase-admin `Auth`.

---

## Types

All four are re-exported so consumers can spell them with a `pyric-admin/auth` import path instead of reaching back into `firebase-admin/auth`:

- `Auth`: alias of `firebase-admin/auth`'s `Auth`. On prod it is literally that object; on the sandbox arms it is a structurally compatible handle whose method set is the subset above.
- `CreateRequest`: firebase-admin's `createUser` properties bag.
- `DecodedIdToken`: firebase-admin's decoded token shape. Sandbox fills required fields with the placeholders documented under `verifyIdToken`.
- `UserRecord`: firebase-admin's user record shape. Sandbox arms build plain objects with the same field set (including `toJSON()`).

---

## Where to go next

- [`pyric-admin/app` reference](../pyric-admin-app-reference-api/) for how the arm is chosen.
- [`pyric/auth` reference](../pyric-auth-reference-api/) for the Web-SDK-shaped mirror with the full sign-in surface.
