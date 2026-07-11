---
title: "API reference: pyric/auth"
navLabel: "API reference"
group: "pyric / auth"
section: "Reference"
order: 157
---
# API reference: `pyric/auth`

Exact signatures of every public export, grouped by purpose. Sandbox-only behavior is called out per function.

For coverage against `firebase/auth`'s full surface, see [feature-matrix.md](../pyric-auth-reference-feature-matrix/).

---

## Initialization

### `getAuth(target)`
```ts
function getAuth(sandbox: Sandbox): Auth;
function getAuth(app: FirebaseApp): Auth;
function getAuth(app: PyricApp): Auth;
```
Construct an `Auth` handle. Idempotent on all three inputs: repeat calls for the same input return the same handle (matches `firebase/auth.getAuth(app)`).

On the sandbox target the handle's backend is memoized per-sandbox; subscribers attached to one handle observe changes driven through any other handle for the same sandbox.

The `PyricApp` overload reads the app's target brand and forwards to the sandbox or `FirebaseApp` path underneath, so `getAuth(app)` works the same whether `app` came from `initializeApp` pointed at a sandbox or at a real Firebase config.

### `connectAuthEmulator(auth, url, options?)`
```ts
function connectAuthEmulator(
  auth: Auth,
  url: string,
  options?: { disableWarnings?: boolean },
): void;
```
Sandbox: no-op (the sandbox IS the emulator). Prod: delegates to `firebase/auth.connectAuthEmulator`.

---

## Sign-in / sign-out

### `signInAnonymously(auth)`
```ts
function signInAnonymously(auth: Auth): Promise<UserCredential>;
```
Sandbox: mints a `User` with an auto-generated uid prefixed `anonymous-`, `isAnonymous: true`, `email: null`. Writes through to `sandbox.currentUser` and fires `onAuthStateChanged`. Reuses the already-signed-in anonymous user instead of minting a new one if one is already current (avoids duplicate identities under double-mount patterns like React StrictMode). Throws `auth/operation-not-allowed` if the `anonymous` provider is disabled (`sandbox.setAuthProviderConfig`).

### `signInWithEmailAndPassword(auth, email, password)`
```ts
function signInWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential>;
```
Sandbox: looks up the user in the in-memory DB seeded via `sandbox.seedUsers`. Email lookup is case-insensitive. Throws `auth/user-not-found` if absent, `auth/wrong-password` on mismatch, `auth/user-disabled` for a disabled account, `auth/operation-not-allowed` if the `password` provider is disabled.

### `createUserWithEmailAndPassword(auth, email, password)`
```ts
function createUserWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential>;
```
Sandbox: appends to the in-memory DB and signs in. Throws `auth/email-already-in-use` if the email is already registered, `auth/operation-not-allowed` if the `password` provider is disabled.

### `signOut(auth)`
```ts
function signOut(auth: Auth): Promise<void>;
```
Sets `currentUser` to `null` and fires listeners. Sandbox no-op if already signed out. `Auth` also exposes this as a method, `auth.signOut()`, delegating to the same free function (`firebase/auth`'s `Auth` exposes both forms).

### `signInWithPopup(auth, provider, resolver?)`
```ts
function signInWithPopup(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential>;
```
Sandbox: resolves through a precedence chain: a per-call `resolver` argument, then one injected via `sandbox.setAuthFlowResolver`, then a one-shot mock staged with `sandbox.mockSignInResult`. With nothing configured it throws `auth/argument-error`, naming the API that was called (matches upstream's no-resolver default). Throws `auth/operation-not-allowed` first if the provider is disabled, and `auth/user-disabled` if the resolved identity is a disabled account. The `resolver` argument is sandbox-only; on a prod-backed handle it is ignored and `firebase/auth` uses its own platform default (browser popup) resolver.

### `signInWithRedirect(auth, provider, resolver?)`
```ts
function signInWithRedirect(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<void>;
```
Sandbox: there's no navigation to redirect through, so this resolves the same resolver precedence as `signInWithPopup` inline, signs the user in immediately, and stashes the resulting credential for the next `getRedirectResult` call. Same error conditions as `signInWithPopup`. Prod: delegates to `firebase/auth` (real navigation away and back).

### `getRedirectResult(auth)`
```ts
function getRedirectResult(auth: Auth): Promise<UserCredential | null>;
```
Sandbox: returns and clears the credential stashed by `signInWithRedirect` (one-shot); `null` if no redirect is pending. Prod: delegates to `firebase/auth`.

### `signInWithCredential(auth, credential)`
```ts
function signInWithCredential(auth: Auth, credential: AuthCredential): Promise<UserCredential>;
```
Sandbox: looks up the pre-staged mock by `credential.providerId` (set via `sandbox.mockSignInResult`). One-shot: each mock is consumed by one sign-in call. Throws `auth/operation-not-allowed` if the provider is disabled, `auth/no-mock-configured` if no mock is staged, `auth/user-disabled` if the resolved identity is disabled.

### `setPersistence(auth, persistence)`
```ts
function setPersistence(auth: Auth, persistence: Persistence): Promise<void>;
```
Sandbox: records the mode on the backend, which migrates any already-stored session uid to the newly selected web-storage slot. No-op if the sandbox has no persistence controller attached. Prod: maps `inMemoryPersistence` / `browserSessionPersistence` / `browserLocalPersistence` to upstream's singletons.

#### Persistence markers
```ts
const inMemoryPersistence: Persistence;      // { type: 'NONE' }
const browserSessionPersistence: Persistence; // { type: 'SESSION' }
const browserLocalPersistence: Persistence;   // { type: 'LOCAL' }
```
Opaque markers passed to `setPersistence`. Sandbox treats them as pure data (their `.type` string selects the web-storage slot); prod hands them straight to `firebase/auth.setPersistence`, which switches on the same singletons.

---

## Observers

### `onAuthStateChanged(auth, observer)`
```ts
function onAuthStateChanged(
  auth: Auth,
  observer:
    | ((user: User | null) => void)
    | { next?: (user: User | null) => void; error?: (e: Error) => void; complete?: () => void },
): Unsubscribe;
```
Fires immediately on subscribe with current state (via microtask). Subsequent fires on every sign-in / sign-out. Multiple subscribers all fire. Unsubscribing during emission does not skip remaining subscribers. Same-identity `setUser` calls do NOT re-fire.

### `onIdTokenChanged(auth, observer)`

Same shape as `onAuthStateChanged`.

Sandbox fires on identity change and on `getIdToken(true)` forced refresh, matching prod (oracle `auth-onidtokenchanged-force-refresh.json`). It does not fire spontaneously, because sandbox tokens don't expire.

### `beforeAuthStateChanged(auth, callback, onAbort?)`
```ts
function beforeAuthStateChanged(
  auth: Auth,
  callback: (user: User | null) => void | Promise<void>,
  onAbort?: () => void,
): Unsubscribe;
```
Registers a BLOCKING gate that runs before a real sign-in/sign-out transition commits — the pattern for gating sign-in with a client-side check (e.g. reject users who fail an allowlist). Callbacks run in registration order and may be async. If a callback throws (or its returned promise rejects), the transition is ABORTED: the pending `signInWith…` / `signOut` call rejects with `auth/login-blocked`, `currentUser` is left unchanged, and `onAuthStateChanged` / `onIdTokenChanged` do NOT fire. Every `onAbort` registered by a callback that already succeeded in the same pass runs, in reverse registration order, so side effects can be undone.

Fires for both directions — a real sign-in (`nextUser` non-null) and a real sign-out (`nextUser === null`). Covers every sign-in path `pyric/auth` has: `signInAnonymously`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `signInWithRedirect`, `signInWithCredential`, and `signOut`.

Does NOT gate the `sandbox.setUser` test driver — that bypass has no prod analog (it already skips provider enforcement the same way). Over the served-worker path (`pyric-tools`'s SharedWorker-backed auth), registering throws immediately rather than silently accepting a callback that could never run — see COMPAT.md.

---

## Token accessors

### `getIdToken(user, forceRefresh?)`
```ts
function getIdToken(user: User, forceRefresh?: boolean): Promise<string>;
```
Top-level mirror of `firebase/auth`'s modular `getIdToken(user)`. Delegates to the `user.getIdToken(forceRefresh)` method, so behavior (and forced-refresh side effects on `onIdTokenChanged`) is identical whichever form calling code uses. Added because generated app code that imports the modular free function otherwise has no matching export.

### `getIdTokenResult(user, forceRefresh?)`
```ts
function getIdTokenResult(user: User, forceRefresh?: boolean): Promise<IdTokenResult>;
```
Top-level mirror of `user.getIdTokenResult(forceRefresh)`.

### `updateProfile(user, profile)`
```ts
function updateProfile(
  user: User,
  profile: { displayName?: string | null; photoURL?: string | null },
): Promise<void>;
```
Updates the signed-in user's `displayName` / `photoURL`. Pass `null` to clear a field, omit it to leave it untouched. Mutates the user object in place, so every held reference, including `auth.currentUser`, reflects the change. Does NOT fire `onAuthStateChanged` / `onIdTokenChanged` (matches upstream). Works without an `auth` handle in scope, matching upstream's user-only signature: it dispatches through a hidden brand every `User` carries back to whichever backend produced it. Throws `auth/invalid-user-token` if `user` wasn't produced by a `pyric/auth` sign-in.

This is the client-facing, signed-in-user form. `sandbox.updateProfile(auth, uid, profile)` (below) is the sandbox-only by-uid admin variant, used when there's no live `User` handle to call this on.

---

## Provider classes

| Class | `PROVIDER_ID` | Instance methods | Static methods |
|---|---|---|---|
| `GoogleAuthProvider` | `'google.com'` | `addScope(scope)`, `setCustomParameters(params)` (both no-ops) | `credential(idToken, accessToken?)`, `credentialFromResult(result)`, `credentialFromError(err)` |
| `EmailAuthProvider` | `'password'` | None | `credential(email, password)`, `credentialWithLink(email, link)` |
| `FacebookAuthProvider` | `'facebook.com'` | `addScope`, `setCustomParameters` (no-ops) | `credential(accessToken)`, `credentialFromResult(result)`, `credentialFromError(err)` |
| `GithubAuthProvider` | `'github.com'` | `addScope`, `setCustomParameters` (no-ops) | `credential(accessToken)`, `credentialFromResult(result)`, `credentialFromError(err)` |
| `OAuthProvider` | set by constructor: `new OAuthProvider('apple.com')` | `addScope`, `setCustomParameters` (no-ops); `credential({idToken?, accessToken?, rawNonce?})` | `credentialFromResult(result)`, `credentialFromError(err)` |

Every provider is a marker class: no real OAuth flow runs on sandbox. `addScope` / `setCustomParameters` exist only so consumer code typechecks unchanged; the sandbox never reads the values they record.

`EmailAuthProvider` doesn't run a popup/redirect flow, so it has no `addScope`, `setCustomParameters`, `credentialFromResult`, or `credentialFromError`, only the two credential constructors. `credentialFromError` returns `null` on every provider (sandbox has no error path that synthesizes a credential).

### `FEDERATED_PROVIDER_IDS` / `FederatedProviderId`
```ts
const FEDERATED_PROVIDER_IDS: readonly [
  'google.com', 'apple.com', 'facebook.com', 'github.com',
  'twitter.com', 'microsoft.com', 'yahoo.com',
];
type FederatedProviderId = (typeof FEDERATED_PROVIDER_IDS)[number];
```
The federated (OAuth) provider ids the sandbox treats as first-class: the dedicated provider classes' ids plus the rest of the standard Firebase IdP set, reached through the generic `OAuthProvider`. Not an allowlist. The backend accepts any provider id, including a custom `new OAuthProvider('oidc.acme')`. Exists so admin surfaces (a provider-toggle UI) can enumerate the supported set mechanically instead of hardcoding a copy. `password` and `anonymous` are deliberately absent: they're credential-derived sign-in methods, not federated links.

---

## Types

- `Auth`: `{ currentUser: User | null, signOut(): Promise<void> }` plus an opaque `TARGET_SYMBOL` brand.
- `User`: `uid`, `email`, `displayName`, `isAnonymous`, `emailVerified?`, `photoURL?`, `phoneNumber?`, `providerId?`, `providerData?: UserInfo[]`, `getIdToken()`, `getIdTokenResult()`.
- `UserInfo`: per-provider profile entry on `User.providerData`, `displayName`, `email`, `phoneNumber`, `photoURL`, `providerId`, `uid`, all readonly.
- `IdTokenResult`: `token`, `claims`, `expirationTime`, `issuedAtTime`, `authTime`, `signInProvider?`.
- `UserCredential`: `user`, `providerId`, `operationType` (`'signIn'` / `'reauthenticate'` / `'link'`).
- `AuthCredential`: `providerId`, `signInMethod`.
- `Persistence`: `{ type: 'NONE' | 'SESSION' | 'LOCAL' }`.
- `AuthObserver`: function form or `{ next, error, complete }` object.
- `Unsubscribe`: `() => void`.
- `AuthProvider`: union of the provider classes (`GoogleAuthProvider | FacebookAuthProvider | GithubAuthProvider | OAuthProvider | { readonly providerId: string }`).
- `AuthFlowRequest`: what a popup/redirect resolver receives, `providerId`, `authType: 'signIn' | 'reauth' | 'link'`, `scopes?: string[]`, `customParameters?: Record<string, unknown>`.
- `AuthFlowResolver`: the pluggable popup/redirect handler, `{ openPopup(req: AuthFlowRequest): Promise<UserCredential>, openRedirect(req: AuthFlowRequest): Promise<UserCredential> }`. Implementations reject with `auth/popup-closed-by-user` when the user dismisses the flow.
- `TARGET_SYMBOL`: a unique symbol brand stamped on every `Auth` handle so the package's own dispatch code can recover sandbox-vs-prod routing. Consumers don't read it.

### Sandbox-driver types

These back the `sandbox.*` methods below; see [sandbox-test-driver.md](../pyric-auth-reference-sandbox-test-driver/) for usage.

- `SeedUser`: `uid`, `email`, `password`, `displayName?`, `customClaims?: Record<string, unknown>`, `providerId?` (defaults to `'password'`). Input shape for `sandbox.seedUsers`; also the output shape of `sandbox.exportUsers`, so the two round-trip losslessly.
- `AuthUserRecord`: emulator-REST-shaped per-user record, `uid`, `email`, `displayName`, `phoneNumber`, `photoUrl` (all `| null`), `customClaims`, `providerUserInfo: ProviderUserInfo[]`, `isAnonymous`, `disabled`, `emailVerified`, `createdAt` (ISO), `lastLoginAt` (ISO or `null`). Returned by `sandbox.listUsers`, `sandbox.createUser`, `sandbox.updateUser`, `sandbox.updateProfile`.
- `ProviderUserInfo`: `{ providerId: string }`, one entry per linked provider on an `AuthUserRecord`.
- `CreateUserRequest`: `sandbox.createUser` input, `uid?` (defaults to a generated `user-<N>`), `email?`, `password?`, `displayName?`, `phoneNumber?`, `photoUrl?`, `customClaims?`, `disabled?`, `emailVerified?`, `providerUserInfo?: ProviderUserInfo[]`.
- `UpdateUserRequest`: `sandbox.updateUser` input, same fields as `CreateUserRequest` minus `uid`, all optional; `undefined` leaves a field untouched, `displayName: null` clears it, `customClaims` replaces the whole map, `providerUserInfo` replaces the whole linked-provider list.
- `SignInIdentitySpec`: `sandbox.createSignInCredential`'s "add account" shape, `uid?` (defaults to `'<providerId>:<email>'`), `email`, `displayName?`, `customClaims?`.
- `MintSessionRequest`: union consumed by `sandbox.mintSession`, `{ kind: 'anonymous' } | { kind: 'password'; email; password } | { kind: 'createPassword'; email; password } | { kind: 'uid'; uid }`.
- `MintedSession`: `{ user: User; state: AuthState }` returned by `sandbox.mintSession`. `state` (from `pyric/sandbox`) is what a per-connection data context needs, e.g. `getFirestore(sandbox.withAuth(session.state))`.

---

## Sandbox-only test driver

`import { sandbox as authSandbox } from 'pyric/auth'`. The name collides with the common `const sandbox = initializeSandbox()` local, so alias on import. Every method below throws `SandboxError` with `code: 'failed-precondition'` if called against a prod-backed `Auth` handle. Signatures only here; see [sandbox-test-driver.md](../pyric-auth-reference-sandbox-test-driver/) for worked examples and the error-handling pattern.

### Session and identity
```ts
setUser(auth: Auth, user: User | null): void;
listIdentities(auth: Auth): Array<{
  uid: string;
  email: string | null;
  displayName: string | null;
  providerId: string;
  providerUserInfo: ProviderUserInfo[];
  isAnonymous: boolean;
  customClaims: Record<string, unknown>;
}>;
createSignInCredential(
  auth: Auth,
  request: { providerId: string; uid: string } | { providerId: string; spec: SignInIdentitySpec },
): UserCredential;
mockSignInResult(auth: Auth, result: UserCredential): void;
restoreSession(auth: Auth, uid: string): User;
mintSession(auth: Auth, request: MintSessionRequest): MintedSession;
```
`setUser` forces the current user directly (`null` signs out), bypassing lookup and mock staging entirely; it does not count as a real sign-in (no `lastLoginAt` bump). `listIdentities` snapshots every seeded/created identity for an account-picker UI; `providerId` is the primary label (first linked provider, or `'anonymous'`). `createSignInCredential` mints a credential for a host-driven pick-existing or add-account flow but does not sign anyone in on its own. Hand the result to a pending `AuthFlowResolver` promise. `mockSignInResult` one-shot-stages the result the next matching `signInWithPopup` / `signInWithCredential` call returns. `restoreSession` re-establishes a signed-in session for an existing identity (fires listeners like a real restore); throws `auth/user-not-found` / `auth/user-disabled`. `mintSession` mints a per-connection identity without touching the shared `auth.currentUser`, the substrate for one sandbox serving multiple authenticated connections.

### Flow wiring
```ts
setAuthFlowResolver(auth: Auth, resolver: AuthFlowResolver | null): void;
```
Installs (or, passed `null`, clears) the popup/redirect resolver that `signInWithPopup` / `signInWithRedirect` delegate to when no per-call resolver is given. The analog of a browser `getAuth` wiring `browserPopupRedirectResolver`.

### Seed and export
```ts
seedUsers(auth: Auth, users: ReadonlyArray<SeedUser>): void;
exportUsers(auth: Auth): SeedUser[];
```
`seedUsers` bulk-loads test users for email/password lookup; re-seeding an existing uid overwrites. `exportUsers` returns the user DB in the exact shape `seedUsers` accepts, so the two round-trip losslessly. Provider-flow identities that never had a password export with a documented sentinel; anonymous users are not exported (ephemeral by design).

### User admin (emulator-REST-shaped)
```ts
listUsers(auth: Auth): AuthUserRecord[];
createUser(auth: Auth, request: CreateUserRequest): AuthUserRecord;
updateUser(auth: Auth, uid: string, update: UpdateUserRequest): AuthUserRecord;
updateProfile(
  auth: Auth,
  uid: string,
  profile: { displayName?: string | null; photoURL?: string | null },
): AuthUserRecord;
deleteUser(auth: Auth, uid: string): void;
clearUsers(auth: Auth): void;
subscribeUsers(auth: Auth, callback: () => void): Unsubscribe;
```
`createUser` creates without signing in (admin semantics; `createUserWithEmailAndPassword` is the signs-you-in client variant). `updateUser` throws nothing for untouched fields (`undefined` = leave alone), replaces `customClaims` wholesale, and setting `disabled: true` blocks future sign-ins (`auth/user-disabled`) without terminating an active session. `updateProfile` (by uid) is the admin counterpart to the top-level `updateProfile(user, profile)` free function above, same field semantics, no live `User` handle required. `deleteUser` / `clearUsers` don't terminate active sessions (prod parity). `subscribeUsers` has a coarse contract: no payload, no initial fire; re-read with `listUsers` inside the callback.

### Sign-in provider config
```ts
getAuthProviderConfig(auth: Auth): Array<{ providerId: string; enabled: boolean }>;
setAuthProviderConfig(auth: Auth, providerId: string, enabled: boolean): void;
assertAuthProviderEnabled(auth: Auth, providerId: string): void;
delegateProviderEnforcement(auth: Auth, delegated: boolean): void;
subscribeAuthProviderConfig(auth: Auth, callback: () => void): Unsubscribe;
```
Mirrors the Authentication → Sign-in method toggles. `password` and `anonymous` default to enabled; every other provider id is disabled until explicitly enabled. `setAuthProviderConfig` gates every sign-in entry point that provider serves; the matching call throws `auth/operation-not-allowed` when disabled, exactly like flipping the console toggle off. Config survives `enablePersistence` round-trips. `assertAuthProviderEnabled` is the same gate, exposed directly for hosts (like a served worker) that enforce it on behalf of an identity resolved elsewhere. `delegateProviderEnforcement` hands this handle's gating to a remote authority (serve-layer wiring); don't set it on a backend that is itself the authority. `subscribeAuthProviderConfig` has the same coarse no-payload contract as `subscribeUsers`.

---

## Boundaries

**Sandbox driver calls fail closed on prod.** Every `sandbox.*` method throws `SandboxError('failed-precondition', …)` when called with a prod-backed `Auth` handle. There is no silent no-op path: code that mixes `sandbox.*` calls into code meant to run against both backends fails loudly at the call site, not later.

**v0 deny list.** The exports below are deliberately absent. Full detail, including the exact reasoning per symbol, lives in [feature-matrix.md](../pyric-auth-reference-feature-matrix/); the shape:

- **Sign-in methods**: `signInWithCustomToken`, `signInWithPhoneNumber`, `signInWithEmailLink` (and `isSignInWithEmailLink` / `sendSignInLinkToEmail`).
- **Multi-factor**: `multiFactor`, `MultiFactorSession`, `getMultiFactorResolver`, `PhoneMultiFactorGenerator`, `TotpMultiFactorGenerator`, `TotpSecret`.
- **Link / unlink / re-authenticate**: `linkWithCredential`, `linkWithPopup`, `linkWithRedirect`, `unlink`, `reauthenticateWithCredential`, `reauthenticateWithPopup`, `reauthenticateWithRedirect`, `reauthenticateWithPhoneNumber`.
- **Client-side profile mutation**: `updateEmail`, `updatePassword`, `verifyBeforeUpdateEmail`, `deleteUser(user)` (a client-side `User` cannot delete itself; the sandbox admin surface is `sandbox.deleteUser(auth, uid)`), `user.reload()`, `user.delete()`.
- **Password reset & email verification**: `sendPasswordResetEmail`, `confirmPasswordReset`, `sendEmailVerification`, `applyActionCode`, `verifyPasswordResetCode`, `checkActionCode`, `revokeAccessToken`, `validatePassword(auth, password)`.
- **Providers**: `TwitterAuthProvider` (use `new OAuthProvider('twitter.com')`), `SAMLAuthProvider`, `PhoneAuthProvider`, `RecaptchaVerifier`.
- **Lifecycle / config**: `initializeAuth` (no custom dependency injection on the sandbox backend), `indexedDBLocalPersistence`, `useDeviceLanguage`, `auth.languageCode`, `auth.tenantId`.
- **User fields**: `user.metadata`, `user.refreshToken`, `user.tenantId`, `user.toJSON()`.
- **Error constants**: the `AuthErrorCodes` module. Use the string literal (`'auth/user-not-found'`, etc.) directly.

None of this is a Firebase gap. It's the v0 scope line: everything above is real, documented `firebase/auth` surface that `pyric/auth` hasn't mirrored yet. Code that imports any of it fails to resolve once the sandbox-preview build aliases `firebase/auth` → `pyric/auth`; it works unmodified against real `firebase/auth` at deploy.
