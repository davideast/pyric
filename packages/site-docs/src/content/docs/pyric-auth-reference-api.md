---
title: "API reference — pyric/auth"
navLabel: "API reference"
group: "pyric / auth"
section: "Reference"
order: 161
---
# API reference — `pyric/auth`

Exact signatures of every public export, grouped by purpose. Sandbox-only behavior is called out per function.

For coverage against `firebase/auth`'s full surface, see [feature-matrix.md](../pyric-auth-reference-feature-matrix/).

---

## Initialization

### `getAuth(target)`
```ts
function getAuth(sandbox: Sandbox): Auth;
function getAuth(app: FirebaseApp): Auth;
```
Construct an `Auth` handle. Idempotent on both targets: repeat calls for the same input return the same handle (matches `firebase/auth.getAuth(app)`).

On the sandbox target the handle's backend is memoized per-sandbox; subscribers attached to one handle observe changes driven through any other handle for the same sandbox.

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
Sandbox: mints a `User` with an auto-generated uid prefixed `anonymous-`, `isAnonymous: true`, `email: null`. Writes through to `sandbox.currentUser` and fires `onAuthStateChanged`.

### `signInWithEmailAndPassword(auth, email, password)`
```ts
function signInWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential>;
```
Sandbox: looks up the user in the in-memory DB seeded via `sandbox.seedUsers`. Email lookup is case-insensitive. Throws `auth/user-not-found` if absent; `auth/wrong-password` on mismatch.

### `createUserWithEmailAndPassword(auth, email, password)`
```ts
function createUserWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential>;
```
Sandbox: appends to the in-memory DB and signs in. Throws `auth/email-already-in-use` if the email is already registered.

### `signOut(auth)`
```ts
function signOut(auth: Auth): Promise<void>;
```
Sets `currentUser` to `null` and fires listeners. Sandbox no-op if already signed out.

### `signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)`
```ts
function signInWithPopup(auth: Auth, provider: AuthProvider): Promise<UserCredential>;
function signInWithCredential(auth: Auth, credential: AuthCredential): Promise<UserCredential>;
```
Sandbox: looks up the pre-staged mock by `providerId` (set via `sandbox.mockSignInResult`). One-shot — each mock is consumed by one sign-in call. Throws `auth/no-mock-configured` if absent.

### `setPersistence(auth, persistence)`
```ts
function setPersistence(auth: Auth, persistence: Persistence): Promise<void>;
```
Sandbox: no-op. Prod: maps `inMemoryPersistence` / `browserSessionPersistence` / `browserLocalPersistence` to upstream's singletons.

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
Fires immediately on subscribe with current state (via microtask). Subsequent fires on every sign-in / sign-out. Multiple subscribers all fire. Unsubscribing during emission does not skip remaining subscribers. Same-identity setUser calls do NOT re-fire.

### `onIdTokenChanged(auth, observer)`

Same shape as `onAuthStateChanged`.

**Sandbox divergence:** fires on user change only. Sandbox issues no token refresh, so a forced `getIdToken(true)` does NOT trigger this channel. Prod fires on both user change and token refresh.

---

## Provider classes

| Class | `PROVIDER_ID` | Notes |
|---|---|---|
| `GoogleAuthProvider` | `'google.com'` | `addScope` / `setCustomParameters` are sandbox no-ops |
| `EmailAuthProvider` | `'password'` | `credential(email, password)` / `credentialWithLink(email, link)` |
| `FacebookAuthProvider` | `'facebook.com'` | |
| `GithubAuthProvider` | `'github.com'` | |
| `OAuthProvider` | from constructor | `new OAuthProvider('apple.com')` |

Each (except `OAuthProvider`) exposes `credentialFromResult(result)` and `credentialFromError(err)` static methods. `credentialFromError` always returns `null` on sandbox (no error → credential synthesis path).

---

## Types

- `Auth` — `{ currentUser: User | null }` plus an opaque `TARGET_SYMBOL` brand.
- `User` — `uid`, `email`, `displayName`, `isAnonymous`, `getIdToken()`, `getIdTokenResult()`.
- `IdTokenResult` — `token`, `claims`, `expirationTime`, `issuedAtTime`, `authTime`.
- `UserCredential` — `user`, `providerId`, `operationType` (`'signIn'` / `'reauthenticate'` / `'link'`).
- `AuthCredential` — `providerId`, `signInMethod`.
- `Persistence` — `{ type: 'NONE' | 'SESSION' | 'LOCAL' }`.
- `AuthObserver` — function form or `{ next, error, complete }` object.
- `Unsubscribe` — `() => void`.

## Sandbox-only test driver

See [sandbox-test-driver.md](../pyric-auth-reference-sandbox-test-driver/).
