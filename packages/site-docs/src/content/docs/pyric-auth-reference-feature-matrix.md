---
title: "Feature matrix: pyric/auth coverage of firebase/auth"
navLabel: "Feature matrix"
group: "pyric / auth"
section: "Reference"
order: 15003
---
# Feature matrix: `pyric/auth` coverage of `firebase/auth`

Side-by-side coverage of the modular Web SDK Auth surface. Use this to decide what's safe to write in code that has to run against both the pyric sandbox and prod Firebase.

**Legend:**

- ✅: exported by `pyric/auth` with the same name and signature as upstream. Works on both backends.
- ⚠️: exported, but with a caveat: signature subset, sandbox-only no-op, runtime parity gap, or similar. Read the note.
- ❌: not exported. Code that imports it will fail to resolve when the sandbox-preview build aliases `firebase/auth` → `pyric/auth`.

The right column ("Use in agent-generated `appSource`?") is the deny-list / allow-list the agent's system prompt should encode once the playground alias swap lands.

---

## Initialization & lifecycle

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `getAuth(app)` | ✅ | Also accepts `Sandbox` overload (sandbox-only) | Yes |
| `initializeAuth(app, deps?)` | ❌ | No custom dependency injection on sandbox backend | No |
| `connectAuthEmulator(auth, url, options?)` | ✅ | No-op on sandbox handles; delegates on prod | Yes |
| `setPersistence(auth, persistence)` | ✅ | Sandbox no-op; prod maps marker to upstream singleton | Yes |
| `inMemoryPersistence` | ✅ | Marker `{type: 'NONE'}`; maps to upstream singleton | Yes |
| `browserSessionPersistence` | ✅ | Marker `{type: 'SESSION'}` | Yes |
| `browserLocalPersistence` | ✅ | Marker `{type: 'LOCAL'}` | Yes |
| `indexedDBLocalPersistence` | ❌ | Browser-specific persistence not modelled in sandbox | No |
| `useDeviceLanguage(auth)` | ❌ | Localization not modelled | No |
| `auth.languageCode` | ❌ | As above | No |
| `auth.tenantId` | ❌ | Multi-tenant not in v0 | No |

## Sign-in / sign-out

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `signInAnonymously(auth)` | ✅ | Sandbox: auto-mints `anonymous-N` uid (recorded in the user DB; `sign_in_provider: 'anonymous'`) | Yes |
| `signInWithEmailAndPassword(auth, email, pw)` | ✅ | Sandbox: lookup in in-memory DB. Disabled accounts (`sandbox.updateUser(…, {disabled: true})`) throw `auth/user-disabled` | Yes |
| `createUserWithEmailAndPassword(auth, email, pw)` | ✅ | Sandbox: adds to in-memory DB with the `password` provider recorded | Yes |
| `signInWithPopup(auth, provider, resolver?)` | ⚠️ | Sandbox: delegates to a configured `AuthFlowResolver` (per-call arg → `sandbox.setAuthFlowResolver` → one-shot `mockSignInResult` → throws `auth/argument-error`, matching upstream's no-resolver default). The `resolver` arg is sandbox-only; prod delegates to `firebase/auth`'s platform default. Sign-in records the provider on the identity (user DB upsert) and throws `auth/user-disabled` for disabled accounts | Yes |
| `signInWithCredential(auth, credential)` | ⚠️ | Mock-or-throw, keyed on `credential.providerId` (not a popup/resolver flow, opens no UI); throws `auth/no-mock-configured` with none staged. Records the provider; disabled accounts throw `auth/user-disabled` | Yes |
| `signInWithRedirect(auth, provider, resolver?)` | ⚠️ | Sandbox: resolves inline via the same `AuthFlowResolver` (no real navigation); signs in + stashes for `getRedirectResult`. Prod: delegates to `firebase/auth` (real navigation) | Yes |
| `getRedirectResult(auth)` | ⚠️ | Sandbox: returns-and-clears the pending redirect credential (one-shot), or `null`. Prod: delegates to `firebase/auth` | Yes |
| `signInWithCustomToken(auth, token)` | ❌ | Custom-token sign-in out of scope v0 | No |
| `signInWithPhoneNumber(auth, phone, verifier)` | ❌ | Phone auth out of scope v0 | No |
| `signInWithEmailLink(auth, email, link)` | ❌ | Email-link sign-in out of scope v0 | No |
| `isSignInWithEmailLink(auth, link)` | ❌ | As above | No |
| `sendSignInLinkToEmail(auth, email, settings)` | ❌ | As above | No |
| `signOut(auth)` | ✅ | Sandbox: sets currentUser to null, emits | Yes |
| `auth.signOut()` (method form) | ✅ | Same as the free function; `firebase/auth`'s `Auth` exposes both (AUTH-GAP) | Yes |

## Observers

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `onAuthStateChanged(auth, observer)` | ✅ | Function + observer-object forms; immediate fire on subscribe | Yes |
| `onIdTokenChanged(auth, observer)` | ✅ | Sandbox: fires on identity change AND on `getIdToken(true)` forced refresh, matching prod (oracle `auth-onidtokenchanged-force-refresh.json`). Does not fire *spontaneously* (sandbox tokens don't expire). | Yes |
| `beforeAuthStateChanged(auth, callback, onAbort?)` | ✅ | Blocking gate: runs before a real sign-in/sign-out transition commits. A throwing callback aborts the transition (`auth/login-blocked`); `currentUser` unchanged, `onAuthStateChanged`/`onIdTokenChanged` don't fire. Covers every sign-in path `pyric/auth` has. Does NOT gate `sandbox.setUser` (test-only, no prod analog) — see COMPAT.md. | Yes |

## Providers

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `GoogleAuthProvider` | ✅ | `PROVIDER_ID = 'google.com'`; `addScope` / `setCustomParameters` no-ops | Yes |
| `EmailAuthProvider` | ✅ | `PROVIDER_ID = 'password'` | Yes |
| `FacebookAuthProvider` | ✅ | `PROVIDER_ID = 'facebook.com'` | Yes |
| `GithubAuthProvider` | ✅ | `PROVIDER_ID = 'github.com'` | Yes |
| `OAuthProvider` | ✅ | Constructor takes `providerId: string` | Yes |
| `TwitterAuthProvider` | ❌ | Use `new OAuthProvider('twitter.com')` instead | No |
| `SAMLAuthProvider` | ❌ | Enterprise SSO out of scope v0 | No |
| `PhoneAuthProvider` | ❌ | Phone auth out of scope v0 | No |
| `RecaptchaVerifier` | ❌ | As above | No |

## Multi-factor

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `multiFactor(user)` | ❌ | MFA out of scope v0 | No |
| `MultiFactorSession` | ❌ | As above | No |
| `getMultiFactorResolver(auth, error)` | ❌ | As above | No |
| `PhoneMultiFactorGenerator` | ❌ | As above | No |
| `TotpMultiFactorGenerator` | ❌ | As above | No |
| `TotpSecret` | ❌ | As above | No |

## Link / unlink / re-authenticate

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `linkWithCredential(user, credential)` | ❌ | Link flows out of scope v0 | No |
| `linkWithPopup(user, provider)` | ❌ | As above | No |
| `linkWithRedirect(user, provider)` | ❌ | As above | No |
| `unlink(user, providerId)` | ❌ | As above | No |
| `reauthenticateWithCredential(user, credential)` | ❌ | Re-auth out of scope v0 | No |
| `reauthenticateWithPopup(user, provider)` | ❌ | As above | No |
| `reauthenticateWithRedirect(user, provider)` | ❌ | As above | No |
| `reauthenticateWithPhoneNumber(user, phone, verifier)` | ❌ | As above | No |

## Profile mutation

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `updateProfile(user, { displayName, photoURL })` | ❌ | Profile mutation out of scope v0 | No |
| `updateEmail(user, newEmail)` | ❌ | As above | No |
| `updatePassword(user, newPassword)` | ❌ | As above | No |
| `verifyBeforeUpdateEmail(user, newEmail, settings?)` | ❌ | As above | No |
| `deleteUser(user)` | ❌ | As above | No |

## Password reset & email verification

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `sendPasswordResetEmail(auth, email, settings?)` | ❌ | Email flows out of scope v0 | No |
| `confirmPasswordReset(auth, code, newPassword)` | ❌ | As above | No |
| `sendEmailVerification(user, settings?)` | ❌ | As above | No |
| `applyActionCode(auth, code)` | ❌ | As above | No |
| `verifyPasswordResetCode(auth, code)` | ❌ | As above | No |
| `checkActionCode(auth, code)` | ❌ | As above | No |
| `revokeAccessToken(auth, token)` | ❌ | As above | No |
| `validatePassword(auth, password)` | ❌ | Password-policy enforcement out of scope v0 | No |

## User token / refresh

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `user.getIdToken(forceRefresh?)` | ⚠️ | Sandbox: returns stable opaque `sandbox-id-token-…` string | Yes |
| `user.getIdTokenResult(forceRefresh?)` | ⚠️ | Sandbox: claims include `customClaims` + synthesized `sub`/`aud`/`iss` + reserved `firebase.sign_in_provider`; `signInProvider` reflects the session's provider (`'anonymous'`/`'password'`/`'google.com'`/…). Claims are read live from the user DB, so `sandbox.updateUser` claims changes land on the next forced refresh (prod parity) | Yes |
| `user.{photoURL, emailVerified, phoneNumber, providerId, providerData}` | ✅ | Present on every `User`; sandbox synthesizes (photoURL/phoneNumber `null`, emailVerified `false`, one `providerData` entry for non-anon); prod passes the real values through (no longer stripped) (AUTH-GAP) | Yes |
| `user.reload()` | ❌ | No remote profile to reload from on sandbox | No |
| `user.delete()` | ❌ | Profile deletion out of scope v0 | No |
| `user.{metadata, refreshToken, tenantId, toJSON()}` | ❌ | Not modeled by the sandbox; documented per AUTH-GAP | No |

## Error code constants

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `AuthErrorCodes` module | ❌ | Use string literals (`'auth/user-not-found'` etc.) | No |
| `FirebaseError` instanceof check | ✅ | Sandbox throws a real `FirebaseError` (from `firebase/app`) with the prod message wrapper `Firebase: <msg> (<auth/...>).`; `err instanceof FirebaseError` holds (AUTH-GAP) | Yes |

## Result & wrapper types

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `Auth` | ✅ | Opaque handle with `currentUser` getter + `TARGET_SYMBOL` brand | Yes |
| `User` | ✅ | Subset: uid, email, displayName, isAnonymous, getIdToken, getIdTokenResult | Yes |
| `UserCredential` | ✅ | `{ user, providerId, operationType }` | Yes |
| `AuthCredential` | ✅ | `{ providerId, signInMethod }` opaque marker | Yes |
| `IdTokenResult` | ✅ | `{ token, claims, expirationTime, issuedAtTime, authTime, signInProvider? }`. `signInProvider` optional at the type level until all `User` minting is backend-owned (post-B1); the sandbox always populates it | Yes |
| `Persistence` | ✅ | `{ type: 'NONE' \| 'SESSION' \| 'LOCAL' }` | Yes |
| `AuthObserver` | ✅ | Function or `{ next, error, complete }` object | Yes |
| `Unsubscribe` | ✅ | `() => void` | Yes |
| `AuthProvider` | ✅ | Union of provider classes | Yes |
| `ActionCodeSettings` | ❌ | Action-code flows out of scope v0 | No |
| `ActionCodeInfo` | ❌ | As above | No |
| `UserMetadata` | ❌ | Not exposed on the v0 User subset | No |
| `UserInfo` | ❌ | As above | No |
| `AdditionalUserInfo` | ❌ | As above | No |

## Sandbox-only additions

These have no `firebase/auth` equivalent. They live under the `sandbox.*` namespace and throw `failed-precondition` if called against a prod-backed handle.

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `sandbox.setUser(auth, user)` | ✅ | Sandbox-only test driver. Bypasses the `disabled` check and does NOT bump `lastLoginAt` (not a real sign-in) | **No**, never appears in deployed app code |
| `sandbox.mockSignInResult(auth, result)` | ✅ | Sandbox-only test driver (one-shot resolver tier) | **No**, same |
| `sandbox.seedUsers(auth, users)` | ✅ | Sandbox-only test driver. Seed records accept optional `providerId` (default `'password'`) | **No**, same |
| `sandbox.setAuthFlowResolver(auth, resolver)` | ✅ | Sandbox-only: installs the popup/redirect resolver (host serves the sign-in UI) | **No**, host wiring, never app code |
| `sandbox.listIdentities(auth)` | ✅ | Sandbox-only: snapshot of seeded/created identities for an account-picker UI. Returns the REAL provider per identity (`providerId` primary label + emulator-shaped `providerUserInfo` array); anonymous users included | **No**, host wiring |
| `sandbox.createSignInCredential(auth, {providerId, uid \| spec})` | ✅ | Sandbox-only: backend-owned credential minting for host-driven flows (account picker pick/add). Tokens route through the backend token cache | **No**, host wiring |
| `sandbox.listUsers(auth)` | ✅ | Sandbox-only user admin: every DB record as an emulator-REST-shaped `AuthUserRecord` | **No**, host wiring |
| `sandbox.createUser(auth, request)` | ✅ | Sandbox-only user admin: create WITHOUT signing in (admin semantics) | **No**, host wiring |
| `sandbox.updateUser(auth, uid, update)` | ✅ | Sandbox-only user admin: displayName/email/password/customClaims/disabled/emailVerified | **No**, host wiring |
| `sandbox.deleteUser(auth, uid)` | ✅ | Sandbox-only user admin. Active session not terminated (prod parity) | **No**, host wiring |
| `sandbox.clearUsers(auth)` | ✅ | Sandbox-only user admin: the emulator's "delete all accounts" | **No**, host wiring |
| `sandbox.subscribeUsers(auth, cb)` | ✅ | Sandbox-only: coarse user-DB-changed callback (no payload, no initial fire; re-list in the callback) | **No**, host wiring |
| `TARGET_SYMBOL` | ✅ | Internal brand; agents should not read it | No |

See [sandbox-test-driver.md](../pyric-auth-reference-sandbox-test-driver/) for the full driver API.

---

## Adjacent surfaces not in this matrix

- `firebase/app`: `initializeApp`, `getApp`, `getApps`, `FirebaseApp`. Used by the playground template; no pyric shim because `getAuth(sandbox)` skips the app handle entirely.

## How this matrix gets used

- **The agent's system prompt** (once the alias swap lands) encodes the "No" column as an explicit deny-list. Agents generating `appSource` won't reach for symbols that break sandbox preview.
- **The sandbox preview build** (deferred follow-up) aliases `firebase/auth` → `pyric/auth`. A ✅ row is guaranteed to work. A ⚠️ row works at the type level but has a sandbox-runtime caveat: acceptable for preview, fix-on-deploy.
- **The deploy build** has no aliases. Whatever the agent imports resolves to real `firebase/auth` in node_modules. Any symbol the upstream SDK exports works; ❌ rows from this matrix only fail in sandbox preview, not in production. The deploy adapter's metafile gate rejects any prod bundle containing `@pyric/*`.

---

## Keeping this matrix honest

Re-run this audit when:

- `pyric/auth` adds or removes exports.
- The upstream `firebase/auth` modular SDK adds a new symbol category (passkeys / WebAuthn extensions, OAuth2 client_credentials grants, etc.).
- The sandbox backend closes a parity gap: flip the row from ⚠️ to ✅. (Done for `onIdTokenChanged` forced-refresh and the popup/redirect resolver flow.)
