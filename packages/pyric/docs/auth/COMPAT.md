<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/auth` compatibility matrix

> **Surface coverage:** 82.4% of Firebase's public exports · 83.3% of what pyric intends to mirror
>
> **Fidelity:** 80.7% (96 of 119 tracked claims match production)
>
> Coverage is about whether the export exists. Fidelity is about whether each claimed interaction matches production Firebase — see the [scoreboard](../conformance/SCORES.md) for what that percentage does and does not mean.

The single readable contract for "what this shim guarantees vs the
production `firebase/auth` SDK."

See the design rationale for the methodology (vocabulary
of conformance / oracle / matrix; how to add rows; how the runner
attributes failures).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match prod but doesn't; failing probe pins it |
| — | **Unsupported** — not implemented yet (deliberately or pending) |
| ? | **Unverified** — claim from docs that we haven't yet observed prod-side |

Probe references: `playground:<name>` means a fixture under
`packages/playground/scripts/fixtures/<name>.tsx`. `unit:<file>`
means a Bun test in `packages/auth/test/<file>`.

---

## `getAuth(target)` — initializer

| # | Behavior | Status | Probe |
|---|---|---|---|
| 1 | Returns a stable `Auth` handle for repeat calls with the same sandbox or sandbox-backed `PyricApp` — one backend and handle per sandbox | ✓ | `unit:sandbox-anonymous.test.ts` + canonical Node register child (`register-child.test.ts`) |
| 2 | `getAuth(sandbox)` dispatches to the sandbox backend | ✓ | `unit:sandbox-anonymous.test.ts` |
| 3 | Without sandbox package swapping, canonical `firebase/auth` imports remain Firebase and never enter this mirror | ? | Direct mirror rejection is locked by `unit:package-resolution.test.ts`; an unswapped production-resolution observation is still needed |
| 4 | After package swapping, bare `getAuth()` resolves the registered default sandbox app; without swapping, Firebase retains its `app/no-app` behavior when no default app exists | ✓ (wrap) | canonical Node register child (`register-child.test.ts`) + oracle: `packages/conformance/observations/auth/auth-bare-getauth-no-default-app.json` (`code: 'app/no-app'` against blockingfun, fb-js-sdk 12.13.0 — confirms unswapped Firebase behavior) |
| 5 | `auth.currentUser` is a live getter, not a snapshot — reads through to the backend on every access | ✓ | implicit in `unit:sandbox-anonymous.test.ts` |

## `signInAnonymously(auth)` — anonymous

| # | Behavior | Status | Probe |
|---|---|---|---|
| 6 | Returns `UserCredential` with `providerId: null`, `operationType: 'signIn'`, and a `User` with `isAnonymous: true`, `email: null`, `displayName: null` | ✓ | `unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-6-anon-credential-shape` (one-claim) + oracle: `packages/conformance/observations/auth/auth-anonymous-credential-providerid.json` (`providerId: null` against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said `providerId: 'anonymous'`; corrected after empirical observation. Sandbox aligned to prod in the same commit. |
| 7 | Auto-generates a uid for fresh sign-ins (sandbox format: `anonymous-{N}`) | ⚠ format | `unit:sandbox-anonymous.test.ts` — prod uids are 28-char base64-ish; sandbox uses a readable counter for debuggability |
| 8 | If an anonymous user is already signed in, returns the SAME user (no fresh uid mint) | ✓ | `unit:sandbox-anonymous.test.ts` ("idempotent while signed in") — fix from #399 |
| 9 | After `signOut`, a subsequent `signInAnonymously` mints a fresh uid | ✓ | `unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-9-anon-fresh-uid-after-signout` (one-claim) |
| 10 | Fires `onAuthStateChanged` exactly once per state transition (no same-value double-fire) | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-10-onauthstatechanged-one-per-transition` (one-claim) — fix from #399 + oracle: `packages/conformance/observations/auth/auth-row-10-onauthstatechanged-one-per-transition.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial null fire → `signInAnonymously` → +1 → `signOut` → +1 → `signInAnonymously` → +1. `eachTransitionFiredExactlyOnce: true` — every transition produces exactly one fire) |
| 11 | Writes through to `sandbox.currentUser` so rules engines see `request.auth.uid` | ✓ | `unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-11-anon-uid-visible-to-rules` (one-claim) |
| 12 | Anonymous users persist across page reload via configured `Persistence` (prod only — sandbox has no persistence layer) | ⚠ | divergence: sandbox memory only; within one tab the user persists, across reload they don't |

## `signInWithEmailAndPassword(auth, email, password)` — password

| # | Behavior | Status | Probe |
|---|---|---|---|
| 13 | Returns `UserCredential` with `providerId: null` (NOT `'password'` — only OAuth/phone responses carry a providerId; upstream `providerIdForResponse` returns null for email/password), `operationType: 'signIn'`, and a `User` with the stored uid + email | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-createUser-operationType.json` (`providerId: null` against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said `providerId: 'password'`; corrected after the oracle contradicted it (AUTH-B2). |
| 14 | Throws `auth/user-not-found` when the email isn't seeded / hasn't been created | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-user-not-found-error-code.json` (`code: 'auth/user-not-found'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 15 | Throws `auth/wrong-password` when the password doesn't match | ✓ | `unit:sandbox-email-password.test.ts`, `playground:auth-email-password` (bundled) + `playground:auth-row-15-wrong-password-rejects` (one-claim) + oracle: `packages/conformance/observations/auth/auth-wrong-password-error-code.json` (`code: 'auth/wrong-password'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 15a | An EMPTY password throws `auth/missing-password` (message "A non-empty password must be provided"), fired before the user-DB lookup so it can't be used to enumerate seeded emails. Upstream maps the `MISSING_PASSWORD` server error (`core/errors.ts:92,282,563`). ⚠ best-known semantics — message text not yet captured against a live project (STOP-flagged for an oracle pass; the `.code` is the load-bearing part). | ⚠ | `unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B11) |
| 16 | Re-signing in after `signOut` returns the **same** uid (passwords persist within the sandbox lifetime) | ✓ | `playground:auth-email-password` (bundled) + `playground:auth-row-16-resignin-same-uid` (one-claim) |
| 17 | Fires `onAuthStateChanged` with the new user once | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-17-signin-email-password-fires-once.json` (against blockingfun, fb-js-sdk 12.13.0: createUser → signOut → subscribe (1 initial null fire) → `signInWithEmailAndPassword` → `firesForSignIn: 1` with the signed-in uid, `lastFireUidMatches: true`) |
| 18 | Email validation (RFC 5322ish) — rejects empty, missing `@`, missing local-part, missing domain with `auth/invalid-email`. Runs on both `signInWithEmailAndPassword` and `createUserWithEmailAndPassword` before any user-DB lookup, so consumers shipping malformed input see the same error sandbox vs prod. | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-18-invalid-email-error-code.json` (`code: 'auth/invalid-email'`, message `Firebase: Error (auth/invalid-email).` against blockingfun, fb-js-sdk 12.13.0) |
| 19 | Password strength requirements — rejects passwords shorter than 6 chars with `auth/weak-password` on `createUserWithEmailAndPassword`. Strength is NOT enforced on `signInWithEmailAndPassword` so previously-seeded weak passwords still let the user in (matches prod's separation of registration vs sign-in). | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-19-weak-password-error-code.json` (`code: 'auth/weak-password'`, message `Firebase: Password should be at least 6 characters (auth/weak-password).` against blockingfun, fb-js-sdk 12.13.0; matrix language "≥6 chars per prod default" empirically confirmed) |
| 69 | Disabled accounts (`sandbox.updateUser(…, {disabled: true})`) reject sign-in with `auth/user-disabled` and prod's documented message (`The user account has been disabled by an administrator.`). Sandbox checks disabled BEFORE the password compare (anti-probing); the exact prod ordering of disabled-vs-wrong-password needs an oracle capture | ✓ code / ? ordering | `unit:sandbox-user-admin.test.ts` ("disabled users") |

## `createUserWithEmailAndPassword(auth, email, password)` — register

| # | Behavior | Status | Probe |
|---|---|---|---|
| 20 | Creates a new user, signs them in automatically (currentUser becomes the new user) | ✓ | `playground:auth-email-password` (bundled) + `playground:auth-row-20-create-user-auto-signs-in` (one-claim), `unit:sandbox-email-password.test.ts` |
| 21 | Returns `UserCredential` with `operationType: 'signIn'` (NOT `'register'` — matches prod) | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-createUser-operationType.json` (`operationType: 'signIn'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 22 | Throws `auth/email-already-in-use` when the email is already registered | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-email-already-in-use-error-code.json` (`code: 'auth/email-already-in-use'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 23 | The created user has `isAnonymous: false`, `email: <input>`, `displayName: null` | ✓ | `unit:sandbox-email-password.test.ts` + `playground:auth-row-23-create-user-shape` (one-claim) |
| 24 | Fires `onAuthStateChanged` with the new user once | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-24-createuser-fires-once.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → `createUserWithEmailAndPassword` → `firesForCreate: 1` with the newly-created uid, `lastFireUidMatches: true`) |

## `signOut(auth)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 25 | Sets `currentUser` to `null` synchronously after resolution | ✓ | `playground:auth-anonymous` (bundled) + `playground:auth-row-25-signout-currentuser-null` (one-claim), `unit:sandbox-anonymous.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-25-signout-currentuser-null-sync.json` (`currentUserIsNullSync: true` against blockingfun, fb-js-sdk 12.13.0 — `auth.currentUser` read in the synchronous continuation immediately after `await signOut(auth)` is already `null`, with no microtask/macrotask required to settle) |
| 26 | Fires `onAuthStateChanged` with `null` exactly once | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-26-signout-fires-null-once` (one-claim) + oracle: `packages/conformance/observations/auth/auth-row-26-signout-fires-null-once.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → `signInAnonymously` → `signOut` → `firesForSignOut: 1` with `lastFireUidWasNull: true`) |
| 27 | Idempotent — `signOut` on already-signed-out user is a no-op (no listener fire) | ✓ | `playground:auth-signout-idempotent` + oracle-confirmed: `packages/conformance/observations/auth/auth-signout-idempotent.json` (`threw: false, redundantSignOutFiredListener: false` against blockingfun) |
| 28 | Clears the active session's persistence in prod; sandbox has no persistence | ⚠ | divergence: same memory-only constraint as the anonymous persistence row |

## `onAuthStateChanged(auth, observer)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 29 | Fires immediately on subscribe with the current value (microtask-deferred) | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-29-onauthstatechanged-initial-fire-timing.json` (`firedSynchronously: 0, firedAfterMicrotask: 1` against blockingfun, fb-js-sdk 12.13.0 — initial fire does NOT arrive in the synchronous tick of `onAuthStateChanged(...)`; it lands after the first microtask flush) |
| 30 | Fires on every subsequent identity change | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` + oracle: `packages/conformance/observations/auth/auth-row-30-onauthstatechanged-fires-on-every-transition.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → `signIn` → `signOut` → `signIn` → `signOut`, each of the 4 transitions produced exactly 1 fire; `eachTransitionFiredExactlyOnce: true`) |
| 30a | Dedups by uid: a same-uid update (profile-shape change, or a same-uid re-sign-in) does NOT re-fire `onAuthStateChanged` — only an actual uid change does. Mirrors upstream `notifyAuthListeners`'s `lastNotifiedUid` gate (`auth_impl.ts:718-723`). (`onIdTokenChanged` still fires on those same-uid updates — see row 38a.) | ✓ | `unit:sandbox-uid-dedup.test.ts` (locks AUTH-B7 / B8) |
| 31 | **No duplicate fire** when subscribe is followed by a synchronous `setCurrentUser` — dedup ensures observer sees the new value once, not twice. Sandbox-only concern: prod has no synchronous state-change API, so the dedup window can't be exercised against the cloud SDK; subscribe-then-async-signIn naturally fires twice (initial + new value) because the microtask between them flushes the initial fire | ✓ | `unit:sandbox-listeners.test.ts` (regression test from #399), `playground:auth-anonymous` + oracle baseline: `packages/conformance/observations/auth/auth-row-31-onauthstatechanged-no-dup-on-sync-transition.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe + async `signInAnonymously` in the same tick produces `totalFires: 2` — `{uid: null, ts: 0}` then `{uid: <user>, ts: ~400ms}`. Confirms prod cannot exhibit the same-tick race; the dedup behavior remains a sandbox-only property) |
| 32 | Returned `Unsubscribe` removes the observer; subsequent state changes do NOT fire it | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-listener-unsub` (bundled) + `playground:auth-row-32-unsubscribe-stops-fires` (one-claim) + oracle: `packages/conformance/observations/auth/auth-row-32-unsubscribe-stops-fires.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 fire on `signInAnonymously` → call `unsub()` → `signOut` + `signInAnonymously` + `signOut` produce zero further fires; `postUnsubFires: 0, unsubscribeStoppedFires: true`) |
| 33 | Multiple subscribers all fire on each change | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-33-multiple-subscribers-all-fire.json` (against blockingfun, fb-js-sdk 12.13.0: two subscribers registered back-to-back each see 1 initial null fire, +1 on `signInAnonymously`, +1 on `signOut`; `bothFiredOnSignIn: true, bothFiredOnSignOut: true`) |
| 33a | Registry is array-backed (matches upstream `util/subscribe.ts`): the SAME observer fn registered N times produces N independent registrations that each fire, and one `Unsubscribe` removes exactly one registration. A resubscribe of a previously-unsubscribed fn fires its initial value again. (Per-registration initial-fire bookkeeping, not a shared per-observer dedup.) | ✓ | `unit:sandbox-listener-registry.test.ts` (locks AUTH-B3 + AUTH-B4) |
| 34 | Unsubscribing during emission does not skip remaining subscribers (snapshotted iteration) | ✓ | `unit:sandbox-listeners.test.ts` |
| 35 | A throwing observer doesn't block other observers from firing | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-35-throwing-observer-doesnt-block-others.json` (`secondObserverContinuedFiring: true` against blockingfun, fb-js-sdk 12.13.0 — observer #1 throws on every call, observer #2 still counts the initial fire AND the post-sign-in fire) |
| 36 | Observer object form (`{next, error, complete}`) works alongside the function form | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-36-observer-object-form-works.json` (against blockingfun, fb-js-sdk 12.13.0: one observer as `NextFn`, another as `{next, error, complete}`. Both forms see 1 initial null fire, +1 on `signInAnonymously`, +1 on `signOut`; `bothFormsFiredOnSignIn: true, bothFormsFiredOnSignOut: true`) |
| 37 | Setting the same user twice does NOT double-fire (structural-equality no-op). Sandbox-internal `setCurrentUser` claim; the prod analog is `signInAnonymously` called twice in a row (per fix #399, the second call returns the same user). | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-37-same-user-no-double-fire.json` (against blockingfun, fb-js-sdk 12.13.0: first `signInAnonymously` fires the listener once; second call returns the same uid (`sameUserAcrossCalls: true`) and does NOT produce a fresh fire (`secondSignInProducedFire: false`). Prod also recognizes the same-user no-op) |

## `onIdTokenChanged(auth, observer)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 38 | Fires on user change (sandbox shares the auth-state path) | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-38-onidtokenchanged-fires-on-user-change.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial fire (null) → `signInAnonymously` → +1 (user₁) → `signOut` → +1 (null) → `signInAnonymously` → +1 (user₂ with fresh uid). Every identity transition produces exactly one fire, matching `onAuthStateChanged`) |
| 38a | Fires on EVERY sign-in, including a same-uid re-sign-in (no `signOut` first) — which mints a fresh token, so a subsequent `getIdToken()` returns a new string. Mirrors upstream `notifyAuthListeners`, which calls `idTokenSubscription.next` on every identity update (`auth_impl.ts:716`). `onAuthStateChanged` stays silent on the same-uid case (row 30a). | ✓ | `unit:sandbox-uid-dedup.test.ts` (locks AUTH-B8) |
| 39 | Fires on token refresh (`getIdToken(true)`) | ✓ | `unit:sandbox-token-refresh.test.ts` — was ⚠ (documented divergence); aligned to prod in commit — sandbox now mints a fresh token on forceRefresh and fires `onIdTokenChanged` (NOT `onAuthStateChanged`, since identity is unchanged). Oracle: `packages/conformance/observations/auth/auth-onidtokenchanged-force-refresh.json` defines the target shape (`refreshFiredListener: true` against blockingfun; subscribe → null fire → `signInAnonymously` → +1 → `getIdToken(true)` → +1 for a total of 3 fires). |
| 40 | Initial-fire semantics match `onAuthStateChanged` | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire.json` (against blockingfun, fb-js-sdk 12.13.0: subscribing both listeners in the same tick yields `sync: {auth: 0, idToken: 0}` → `microtask: {auth: 1, idToken: 1}` → no further fires. Both listeners share the microtask-deferred initial-fire timing) |

## `setPersistence(auth, persistence)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 41 | Accepts `inMemoryPersistence` / `browserSessionPersistence` / `browserLocalPersistence` markers without throwing | ✓ | `unit:types.test.ts` |
| 42 | Returns `Promise<void>` | ✓ | `unit:types.test.ts` |
| 43 | Actually changes where the auth state is persisted | ⚠ | divergence: sandbox is a no-op. Prod respects the marker. |
| 43a | An unrecognized persistence marker is rejected with `auth/argument-error` rather than silently coerced to LOCAL | ✓ | `unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B12) |

## `signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 44 | Returns the pre-staged `UserCredential` registered via `sandbox.mockSignInResult(auth, …)` | ✓ | `unit:sandbox-providers.test.ts` |
| 45 | Throws `auth/no-mock-configured` when no mock is pre-staged | ✓ | `unit:sandbox-providers.test.ts` |
| 46 | Mock is consumed after one read (subsequent call without a fresh stage throws again) | ✓ | `unit:sandbox-providers.test.ts` |
| 47 | After successful sign-in, `currentUser` becomes the mock's `user`, listeners fire | ✓ | `unit:sandbox-providers.test.ts` |
| 47a | The credential's rich `User` (email / displayName / isAnonymous) survives the transition — popup/redirect/credential/`setUser` do NOT clobber it down to the bare `AuthState`; `cred.user === auth.currentUser` (reference identity, matches upstream `_updateCurrentUser(userCredential.user)`) | ✓ | `unit:sandbox-user-identity.test.ts` (locks AUTH-B1) |
| 48 | Opens a popup window in prod | ⚠ | divergence: sandbox skips the popup; mock pre-stage replaces the popup result |
| 49 | Cancels with `auth/popup-closed-by-user` when the user dismisses the popup (prod) | — | not modeled — would require the host to expose a "cancel" affordance on the mock |
| 70 | Provider-flow sign-ins (popup / redirect / credential) record the flow's `providerId` on the identity in the user DB (upsert for unknown uids; append-if-missing for known ones) and reject disabled accounts with `auth/user-disabled` before any state change | ✓ | `unit:sandbox-user-admin.test.ts` ("provider tracking", "disabled users") — provider recording is sandbox bookkeeping for `listIdentities`/`listUsers`; prod's auto-link semantics are narrower (same-email Google auto-link only) and not modeled |

## `signInWithRedirect` / `getRedirectResult` / resolver seam

| # | Behavior | Status | Probe |
|---|---|---|---|
| 49a | `signInWithRedirect(auth, provider, resolver?)` resolves the flow (per-call resolver → injected → one-shot mock → `auth/argument-error`), signs the user in, and stashes the credential for one `getRedirectResult` | ✓ | `unit:sandbox-resolver.test.ts` |
| 49b | `getRedirectResult(auth)` returns the stashed credential once, then `null` (one-shot, matches prod) | ✓ | `unit:sandbox-resolver.test.ts` |
| 49c | `sandbox.setAuthFlowResolver(auth, resolver \| null)` installs / clears the popup/redirect resolver (the analog of browser `getAuth` wiring `browserPopupRedirectResolver`) | ✓ | `unit:sandbox-resolver.test.ts` |
| 49d | `sandbox.listIdentities(auth)` snapshots every seeded/created identity for a host account-picker (sandbox-only — no `firebase/auth` equivalent) | ✓ | `unit:sandbox-resolver.test.ts` |

## `Auth` surface + error shape

| # | Behavior | Status | Probe |
|---|---|---|---|
| 49e | `auth.signOut()` method form works alongside the free `signOut(auth)` function (`firebase/auth`'s `Auth` exposes both) (AUTH-GAP) | ✓ | `unit:auth-gap-surface.test.ts` |
| 49f | Sandbox auth errors are real `FirebaseError` instances (`err instanceof FirebaseError`) carrying the prod message wrapper `Firebase: <message> (<auth/...>).` — e.g. `Firebase: Error (auth/invalid-email).`, matching the oracle (AUTH-GAP) | ✓ | `unit:auth-gap-surface.test.ts` |

## Provider classes (`GoogleAuthProvider`, `EmailAuthProvider`, etc.)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 50 | Exports the same constructor signatures as `firebase/auth` for each provider | ✓ | type-only smoke in `unit:types.test.ts` |
| 51 | `Provider.credential(...)` static factories produce `AuthCredential`-shaped objects | ✓ | `unit:sandbox-providers.test.ts` |
| 52 | `GoogleAuthProvider.providerId === 'google.com'` (and per-provider analogs) | ✓ | `unit:sandbox-providers.test.ts` |
| 53 | Custom scopes / params / language code | — | sandbox ignores; prod forwards |

## `User` methods

| # | Behavior | Status | Probe |
|---|---|---|---|
| 54 | `user.getIdToken()` returns a stable opaque token in sandbox (`sandbox-id-token-…`) | ✓ | `unit:sandbox-anonymous.test.ts` |
| 55 | `user.getIdToken(true)` (forceRefresh) returns a NEW token; subsequent `getIdToken(false)` returns the cached new token | ✓ | `unit:sandbox-token-refresh.test.ts` — was ⚠ (documented divergence); aligned to prod in commit — sandbox now mints a fresh token on forceRefresh and fires `onIdTokenChanged`. Oracle: `packages/conformance/observations/auth/auth-getidtoken-force-refresh.json` defines the target shape (`forceRefreshReturnedDifferentString: true`, `token1EqualsToken2: true` against blockingfun — the refreshed token is cached, so a subsequent non-forced read returns it, not yet another fresh one). Sandbox tokens stay `sandbox-id-token-<uid>-<hash>` strings; prod's are real JWTs. |
| 56 | `user.getIdTokenResult()` returns claims | ✓ | `unit:sandbox-providers.test.ts` (custom-claims path) |
| 57 | `user.uid`, `user.email`, `user.displayName`, `user.isAnonymous` reflect the source | ✓ | `playground:auth-anonymous`, `playground:auth-email-password` |
| 58 | `user.emailVerified` — present on every sandbox-minted `User` (default `false`; sandbox has no verification flow). Prod passes the real value through (no longer stripped). The admin record (`sandbox.listUsers`) carries it too | ✓ | `unit:auth-gap-surface.test.ts` (locks AUTH-GAP) |
| 58a | `user.photoURL` / `user.phoneNumber` — present (sandbox default `null`; prod passes through, no longer stripped) | ✓ | `unit:auth-gap-surface.test.ts` |
| 58b | `user.providerId` (aggregate, `'firebase'`) + `user.providerData: UserInfo[]` — sandbox synthesizes one provider entry for non-anonymous users, empty for anonymous; prod passes the real array through (no longer stripped). The admin record carries the emulator-shaped `providerUserInfo` | ✓ | `unit:auth-gap-surface.test.ts` |
| 59 | `user.metadata.creationTime` / `lastSignInTime` | — | client `User.metadata` not exposed (AUTH-GAP); the admin record carries `createdAt`/`lastLoginAt` (ISO) |
| 68 | `IdTokenResult.signInProvider` reflects the session's provider per flow (`'anonymous'` / `'password'` / `'google.com'` / …); claims include the reserved `firebase.sign_in_provider` (custom claims can't shadow it) | ✓ | `unit:sandbox-user-admin.test.ts` ("IdTokenResult.signInProvider") — prod shape is documented SDK behavior; no oracle capture yet |
| 75 | Custom-claims changes (`sandbox.updateUser` / re-seed) reach an active session on the next FORCED token refresh, not immediately — claims are read live from the user DB at mint time (prod's refresh-propagation story; AUTH-B10) | ✓ | `unit:sandbox-user-admin.test.ts`, `unit:sandbox-cluster-b9-b12.test.ts` |
| 61 | `user.reload()` / `user.delete()` / `user.toJSON()` / `user.refreshToken` / `user.tenantId` | — | not modeled by the sandbox; documented in the deny-list rather than synthesized (AUTH-GAP) |
| 62 | `updateProfile(user, {displayName, photoURL})` | — | not implemented |

## `beforeAuthStateChanged(auth, callback, onAbort?)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 76 | Registers a BLOCKING gate that runs before a real sign-in/sign-out transition commits. Callbacks run in registration order; a callback that throws (or returns a rejected promise) aborts the transition entirely: the pending `signInWith…`/`signOut` call rejects with `auth/login-blocked`, `currentUser` is unchanged, and `onAuthStateChanged`/`onIdTokenChanged` do NOT fire. Covers every sign-in path that exists in `pyric/auth`: `signInAnonymously`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `signInWithRedirect`, `signInWithCredential`, and `signOut` (pyric has no `signInWithCustomToken` yet). Modeled after the real `@firebase/auth` `AuthMiddlewareQueue.runMiddleware` (`auth_impl.ts`), read directly from the installed SDK source, not just its `.d.ts`. | ✓ | `unit:sandbox-before-auth-state-changed.test.ts` — implementation cross-checked against `@firebase/auth`'s `AuthMiddlewareQueue` source (registration-order queue, per-callback try/await, `auth/login-blocked` wrap). No live-oracle capture (no observable client-visible signal to probe beyond the documented+sourced contract already read). |
| 76a | `onAbort` semantics: when a callback throws, every `onAbort` registered by a callback that ALREADY SUCCEEDED in the same pass runs, in REVERSE registration order — matches upstream's rollback-stack (`runMiddleware`'s `onAbortStack`). An `onAbort` that itself throws is swallowed so it can't mask the original block reason or skip the remaining rollbacks. | ✓ | `unit:sandbox-before-auth-state-changed.test.ts` ("onAbort runs (in reverse order)…", "a callback whose own onAbort throws…") |
| 76b | Fires on BOTH directions: a real sign-in (`nextUser` non-null) and a real sign-out (`nextUser === null`) — a throwing callback blocks `signOut` too, leaving the previous user signed in. Matches upstream, where the same middleware queue gates `_updateCurrentUser` and `signOut`. | ✓ | `unit:sandbox-before-auth-state-changed.test.ts` ("fires on sign-out too…") |
| 76c | `sandbox.setUser` (the sandbox-only test driver) BYPASSES the gate entirely — it is a raw identity force with no prod analog (same bypass it already has for provider enforcement / `signInProvider` tracking), so no registered `beforeAuthStateChanged` callback runs and none can block it. | ⚠ | `unit:sandbox-before-auth-state-changed.test.ts` ("sandbox.setUser test driver bypasses the gate") |
| 76d | Served-worker path (SharedWorker-backed auth in `@pyric/cli`): the worker owns the shared user pool and commits transitions on its own side of the port, so a page-local `beforeAuthStateChanged` registration can't actually gate a worker-driven sign-in. Rather than silently accept a callback that could never run, registering THROWS immediately (`auth/operation-not-supported-in-this-environment`) — same defensive pattern as `signInWithCredential` over the worker. | ⚠ | `packages/cli/src/serve/worker/client.ts` (`beforeAuthStateChanged` throws `makeUnsupported`) |

## User-management and session exports

| # | Behavior | Status | Probe |
|---|---|---|---|
| 82 | Aliases `getAuth(app)` and returns the same stable `Auth` handle — an app that calls `initializeAuth` instead of `getAuth` gets an equivalent, working instance. The optional `Dependencies` arg (persistence / popupRedirectResolver) is accepted for signature parity but not applied (persistence is already a documented sandbox no-op). Repeated calls return the cached handle rather than throwing `auth/already-initialized` | ✓ | `unit:fruit-aliases.test.ts` — returns the same instance as `getAuth`, with a live `currentUser` |
| 83 | Deletes the account from the user store AND signs the user out if they are current (fires `onAuthStateChanged(null)`), matching prod where deleting the signed-in user clears `auth.currentUser`. Real behavior: a subsequent `signInWithEmailAndPassword` for that identity throws `auth/user-not-found` | ✓ | `unit:fruit-aliases.test.ts` — user removed from the store, sign-out fired, re-sign-in throws `auth/user-not-found` |
| 84 | Changes the stored email (via the same path as `sandbox.updateUser`, rejecting `auth/email-already-in-use` / `auth/invalid-email`) and mutates the held `user` in place, so the next sign-in resolves against the new email. Leniency vs prod: the sandbox does NOT enforce `auth/requires-recent-login` and is not routed through `verifyBeforeUpdateEmail` (which the real SDK requires when email-enumeration protection is on) | ⚠ email really changes; no requires-recent-login / verifyBeforeUpdateEmail enforcement | `unit:fruit-aliases.test.ts` — stored email changes; re-sign-in works with the new email, fails with the old |
| 85 | Sets the stored password (validated for strength). The sandbox DOES store and verify passwords, so this is a real mutation: a subsequent `signInWithEmailAndPassword` with the new password succeeds and the old one throws `auth/wrong-password`. Leniency vs prod: no `auth/requires-recent-login` enforcement | ⚠ password really changes + is verified; no requires-recent-login enforcement | `unit:fruit-aliases.test.ts` — new password signs in, old password throws `auth/wrong-password` |
| 86 | Re-reads the stored record into the `user` object in place, so a change made out of band (e.g. `sandbox.updateUser`) is reflected on the held reference — matching prod's server refresh. Users not tracked in the DB (anonymous / popup) have nothing to refresh (safe no-op) | ✓ | `unit:fruit-aliases.test.ts` — an out-of-band `sandbox.updateUser` displayName change is visible on the held user after `reload` |
| 87 | Sets the sandbox's current user (pass `null` to sign out), firing `onAuthStateChanged` — `auth.currentUser` reflects the passed user afterward | ✓ | `unit:fruit-aliases.test.ts` — `auth.currentUser` becomes the passed user; `null` signs out |
| 88 | Accepted no-op — the sandbox has no device locale to read, so there is no language to set; accepted so init code that calls it compiles + runs | ⚠ no device locale in the sandbox | `unit:fruit-aliases.test.ts` — resolves/returns without error |

## `ActionCodeURL` / email-link / action-code — the out-of-band family

| # | Behavior | Status | Probe |
|---|---|---|---|
| 150 | Parses an out-of-band action link. The `mode` query param maps to a NORMALIZED operation (`mode=resetPassword` -> `PASSWORD_RESET`, `mode=signIn` -> `EMAIL_SIGNIN`), `oobCode` surfaces as `code`, `lang` as `languageCode`, and `continueUrl` comes out URL-DECODED. A link missing `mode`, missing `oobCode`, carrying an unknown mode, or that is not a URL at all parses to `null` — the parse NEVER throws. `parseActionCodeURL` and `ActionCodeURL.parseLink` agree. | ✓ | ORACLE-BACKED and project-independent: this is a PURE client-side parse (no network, no project, no mailbox), so the sandbox owes prod an exact match and there is no room for a divergence. Oracle: `auth-actioncodeurl-parse` against firebase-js-sdk 12.13.0. Replayed in `unit:oracle-conformance.test.ts`. |
| 151 | Pure predicate over the link string — no network. `true` only for a link whose mode is `signIn` AND which carries an `oobCode`; `false` for a password-reset link, for `mode=signIn` with no code, for garbage, and for the empty string. Never throws. | ✓ | ORACLE-BACKED, project-independent (no server involved): `auth-issigninwithemaillink-predicate` captured all five cases against prod. Replayed in `unit:oracle-conformance.test.ts`. |
| 152 | Redeems an out-of-band code and performs its state change (`VERIFY_EMAIL` sets `emailVerified`, `VERIFY_AND_CHANGE_EMAIL` moves the account to the new address). Throws `auth/invalid-action-code` for a code the project never issued, for the empty string, and for a code already redeemed (single-use). A `PASSWORD_RESET` code is refused — `confirmPasswordReset` owns that one. | ✓ | ORACLE-BACKED on the reject path: `auth-action-code-invalid` confirmed prod emits `auth/invalid-action-code` for both a bogus code and the empty string (this endpoint is NOT gated on the password provider, so it answered honestly). The APPLY path (a real code, redeemed) cannot be probed from a client — it needs a code from a real inbox — and is unit-backed end to end against the sandbox outbox in `unit:sandbox-email-link.test.ts`. |
| 153 | ActionCodeSettings validation, enforced CLIENT-side before any request leaves the process: a missing or unparseable `url` throws `auth/invalid-continue-uri` (NOT `auth/missing-continue-uri`, despite the constant's name), and `handleCodeInApp` other than `true` throws `auth/argument-error`. On success the sandbox mints a single-use code and posts the message to the outbox. | ✓ | ORACLE-BACKED on both client-side arms (project-independent — prod threw before any network call): `auth-sendsigninlinktoemail-settings-validation` captured `missingUrl: auth/invalid-continue-uri` and `handleCodeInAppFalse: auth/argument-error`. Replayed in `unit:oracle-conformance.test.ts`; the send path is unit-backed in `unit:sandbox-email-link.test.ts`. |
| 154 | Redeems the code in a sign-in link. A link carrying no `oobCode` throws `auth/argument-error` CLIENT-side (the SDK never reaches the server to ask about a code it cannot find in the link). A first-time sign-in for an address CREATES the account, `getAdditionalUserInfo(cred).isNewUser` is `true`, and the account arrives `emailVerified: true` — redeeming a code mailed to that address is proof of control. The code is single-use. | ✓ | ORACLE-BACKED on the client-side reject (`auth-signinwithemaillink-invalid-link`: `noOobCode: auth/argument-error`). The REDEMPTION path could not be probed: the oracle project has email-link sign-in disabled, so the server arm answered `auth/operation-not-allowed`. That half is unit-backed end to end against the sandbox outbox (`unit:sandbox-email-link.test.ts` drives send -> read the outbox -> sign in). |
| 155 | For an address NO account owns, prod RESOLVES silently — it does not throw `auth/user-not-found`. Email Enumeration Protection is on by default and refusing to leak account existence is the point. The sandbox matches: it resolves and mails nothing. A malformed address still throws `auth/invalid-email`. For a real account, the sandbox mails a reset code; `confirmPasswordReset` redeems it and the new password signs in while the old one throws `auth/wrong-password`. | ✓ | ORACLE-BACKED on the enumeration-protection behavior — the fact most likely to be got wrong: `auth-sendpasswordresetemail-unknown-user` captured `resolvedForUnknownUser: true`, `unknownUserCode: null`, `malformedEmailCode: auth/invalid-email`. A shim that threw `auth/user-not-found` here would hand agent code an account oracle production deliberately removed. Reset round trip unit-backed in `unit:sandbox-email-link.test.ts`. |
| 156 | Throws `auth/missing-email` for a user with no email on the account (an anonymous user). For a real account the mail goes out and NOTHING ELSE HAPPENS: `user.emailVerified` stays `false`. Verification happens when the code in the message is redeemed (`applyActionCode`), not when it is sent. | ✓ | ORACLE-BACKED on the anonymous reject: `auth-sendemailverification-shape` captured `anonymousUserCode: auth/missing-email` against prod. The send-does-not-verify property is the one the whole flow turns on and is unit-backed (`unit:sandbox-email-link.test.ts` asserts `emailVerified` is still false after the send and true only after the code is applied) — it cannot be oracle-confirmed end to end because confirming it would require reading a real inbox. |
| 157 | Mails a code to the NEW address and returns. The account's email does NOT change until that code is redeemed — the single guarantee separating this API from a bare `updateEmail`: the user must prove control of the new address before it becomes theirs. On redemption the account moves and the new address arrives `emailVerified: true`. `checkActionCode` on the code reports `data.email` = the new address and `data.previousEmail` = the old one. | ✓ | UNIT-BACKED, not oracle-backed, and the reason is recorded rather than hidden: the probe (`auth-verifybeforeupdateemail-shape`) ran against the real project and came back `auth/operation-not-allowed` on every arm, because the oracle project has the Email/Password provider DISABLED and the probe could not even create the user whose email it would change. The capture is committed showing exactly that. Behavior is proven end to end against the sandbox in `unit:sandbox-email-link.test.ts`. |
| 158 | The sandbox IS the mail server. Every send posts a real message (operation, recipient, single-use code, and the full action link) to an outbox; `sandbox.takeAuthMail` reads it — the program's substitute for a human opening an inbox. The mailed link round-trips through the public `isSignInWithEmailLink` / `parseActionCodeURL` unchanged, and its code is the code the redeemer accepts, so the round trip production cannot complete without a human closes in-process. An installed `AuthMailResolver` is additionally notified per message; a resolver that THROWS does not fail the send that produced it. | ✓ | `unit:sandbox-email-link.test.ts` — sandbox-only driver (no `firebase/auth` counterpart; this is the seam that makes the family testable at all). |
| 159 | `checkActionCode` and `verifyPasswordResetCode` INSPECT a code without burning it — a check must not destroy the code the subsequent apply needs. `confirmPasswordReset` redeems it and sets the password, running the same strength check `createUserWithEmailAndPassword` runs; a weak new password throws `auth/weak-password` and does NOT burn the code (a typo must not destroy the user's one reset link). A code staged as expired throws `auth/expired-action-code`. | ✓ | UNIT-BACKED, stated honestly: these three endpoints answered `auth/operation-not-allowed` in the oracle run (`auth-action-code-invalid`) because the oracle project's disabled password provider replies before the invalid-code contract can. That is a fact about the project's configuration, not about the API, so it is NOT asserted as evidence. The error codes used here are matched to the oracle-CAPTURED `AuthErrorCodes` map (`INVALID_OOB_CODE = auth/invalid-action-code`, `EXPIRED_OOB_CODE = auth/expired-action-code` — see auth#172). Behavior proven in `unit:sandbox-email-link.test.ts`. |
| 163 | Prod rejects a continue URL whose domain is not on the project's authorized-domains list. The sandbox has NO domain allowlist and does not invent one: it accepts any parseable continue URL. A continue URL that would be rejected in production is accepted here. | ⚠ | The sandbox has no project config to hold an authorized-domains list, so there is nothing to check against; inventing an allowlist would mean inventing a policy the user never set. The probe attempted the server arm (`auth-sendsigninlinktoemail-settings-validation`, `unauthorizedDomain`) but the oracle project has email-link sign-in disabled, so it answered `auth/operation-not-allowed` rather than `auth/unauthorized-continue-uri` — the divergence is declared from the documented contract, not from a capture we do not have. |

## `linkWithCredential` / `linkWithPopup` / `linkWithRedirect` / `unlink` — account linking

| # | Behavior | Status | Probe |
|---|---|---|---|
| 160 | The ANONYMOUS UPGRADE. Linking an email credential onto an anonymous account upgrades it IN PLACE: the uid is PRESERVED, `isAnonymous` flips to `false`, the email is set, and `providerData` gains the provider. Preserving the uid is what keeps the data the user created while anonymous theirs. Returns a `UserCredential` with `operationType: 'link'` and `getAdditionalUserInfo().isNewUser === false` (a link never creates an identity). The linked credential then works as a first-class `signInWithEmailAndPassword`. | ✓ | UNIT-BACKED, not oracle-backed — stated plainly. The probe (`auth-link-email-credential-to-anonymous`) ran against the real project and returned `linkCode: auth/operation-not-allowed`: the oracle project has the Email/Password provider DISABLED, so no email credential can be minted there and the flow cannot be reached. The capture is committed showing exactly that rather than being dropped. Behavior proven in `unit:sandbox-linking-reauth.test.ts`, including the uid-preservation invariant. |
| 161 | `auth/provider-already-linked` when the account already carries the provider (one identity per provider). `auth/email-already-in-use` when the email credential belongs to a DIFFERENT account — an address can back only one identity, so the link cannot be granted without stealing it. | ✓ | UNIT-BACKED. The probe (`auth-link-conflicts`) ran and every arm returned `auth/operation-not-allowed` (same disabled Email/Password provider on the oracle project), so the conflict codes could not be observed against prod. They are matched instead to the oracle-CAPTURED `AuthErrorCodes` map (`PROVIDER_ALREADY_LINKED = auth/provider-already-linked`, `CREDENTIAL_ALREADY_IN_USE = auth/credential-already-in-use` — auth#172) and proven in `unit:sandbox-linking-reauth.test.ts`. NOTE: for an EMAIL credential the sandbox emits `auth/email-already-in-use`, the code prod uses for an address collision; `credential-already-in-use` remains the OAuth-credential case. |
| 162 | Detaches a provider and returns the updated user with a SHRUNKEN `providerData`. Unlinking a provider that was never linked throws `auth/no-such-provider`. Unlinking `'password'` takes the password with it, so `signInWithEmailAndPassword` for that account stops working. Unlinking the LAST provider does NOT re-anonymize the account — `isAnonymous` describes how an identity was born, not what it currently carries. | ✓ | ORACLE-BACKED on the reject path — the ONE linking fact the oracle could reach, because it needs no email credential: `auth-unlink-provider` captured `noSuchProviderCode: auth/no-such-provider` against prod on an anonymous user. Replayed in `unit:oracle-conformance.test.ts`. The detach path is unit-backed (`unit:sandbox-linking-reauth.test.ts`). |
| 164 | Route through the SAME `AuthFlowResolver` seam as `signInWithPopup`, with `authType: 'link'` on the request so a host UI can present 'link your Google account' rather than 'sign in'. The resolved credential names the provider to attach; the sandbox performs the attach and the uid is preserved. A disabled provider throws `auth/operation-not-allowed` AHEAD of the resolver check — a code deliberately distinct from `auth/argument-error`, which keeps meaning 'enabled, but no resolver/mock wired'. | ✓ | `unit:sandbox-linking-reauth.test.ts` — asserts the resolver sees `authType: 'link'`, the uid is preserved, and the two error codes stay distinct. The OAuth arm cannot be oracle-probed at all (it needs a real IdP popup and a human), which is precisely why it goes through the resolver seam. |

## `reauthenticateWithCredential` / `reauthenticateWithPopup` / `reauthenticateWithRedirect` — re-authentication

| # | Behavior | Status | Probe |
|---|---|---|---|
| 170 | Really re-verifies: an email credential is checked against the stored password exactly as `signInWithEmailAndPassword` checks it. A wrong password throws `auth/wrong-password`. A credential belonging to a DIFFERENT account throws `auth/user-mismatch` — checked BEFORE the password compare, so it cannot leak whether the other account's password was right. On success a fresh ID token is minted (a new `authTime`), and the returned `UserCredential` carries `operationType: 'reauthenticate'`. | ✓ | UNIT-BACKED, and the reason it is not oracle-backed is recorded rather than glossed: the probe (`auth-reauthenticate-with-credential`) ran against the real project and could not even create the two accounts it needs — `setupCode: auth/operation-not-allowed`, because the oracle project has the Email/Password provider DISABLED. The capture is committed showing that. `auth/user-mismatch` is matched to the oracle-captured `AuthErrorCodes` map (auth#172). Behavior proven in `unit:sandbox-linking-reauth.test.ts`. |
| 176 | In production the POINT of re-authentication is the `auth/requires-recent-login` gate: `updateEmail` / `updatePassword` / `deleteUser` refuse to run on a session whose sign-in is older than a few minutes, and re-auth is how you clear it. The sandbox does NOT enforce that gate — those three mutations already run on a session of any age (a pre-existing documented divergence), so there is no gate here for re-auth to clear. What re-auth DOES do here is real but narrower: it genuinely re-verifies the credential, mints a fresh token, and returns `operationType: 'reauthenticate'`. Code that calls it runs unchanged against prod, where it also clears the gate. | ⚠ | Declared divergence, not a bug: inventing a recent-login gate would break every existing sandbox flow (which never re-authenticates) while proving nothing. `unit:sandbox-linking-reauth.test.ts` pins the behavior that IS provided (real credential re-verification + a fresh token). |
| 177 | Route through the shared resolver seam with `authType: 'reauth'`. The identity the resolver produces MUST be the user being re-authenticated — a resolver that hands back a different uid throws `auth/user-mismatch`. That check is the entire security content of the flow; without it 're-authentication' would accept anyone. | ✓ | `unit:sandbox-linking-reauth.test.ts` — asserts the resolver sees `authType: 'reauth'` and that an impostor identity is rejected with `auth/user-mismatch`. |

## Constants, credentials, and inert config tokens

| # | Behavior | Status | Probe |
|---|---|---|---|
| 171 | Returns `{ isNewUser, profile, providerId }`. For a fresh anonymous sign-in prod reports `{ isNewUser: true, providerId: null, profile: {} }` — `providerId` is NULL, not `'anonymous'`, because anonymous is not a federated provider. `isNewUser` is `true` for `createUserWithEmailAndPassword`, a first-time email-link sign-in, and a custom-token sign-in that minted the account; `false` for a returning `signInWithEmailAndPassword` and for every `link` / `reauthenticate`. | ✓ | ORACLE-BACKED on the anonymous shape: `auth-additional-user-info-shape` captured `{isNewUser: true, providerId: null, profile: {}}` against prod. Replayed in `unit:oracle-conformance.test.ts`. The email/password arms of the probe were blocked by the oracle project's disabled password provider and are unit-backed instead. |
| 172 | The constant maps, value for value. `OperationType.SIGN_IN === 'signIn'`, `SignInMethod.EMAIL_LINK === 'emailLink'`, `ProviderId.GOOGLE === 'google.com'`, `ActionCodeOperation.PASSWORD_RESET === 'PASSWORD_RESET'`, and the 106-entry `AuthErrorCodes` map (`INVALID_OOB_CODE === 'auth/invalid-action-code'`, `PROVIDER_ALREADY_LINKED === 'auth/provider-already-linked'`, `NO_SUCH_PROVIDER === 'auth/no-such-provider'`, `USER_MISMATCH === 'auth/user-mismatch'`, …). | ✓ | ORACLE-BACKED, snapshotted straight from the shipped SDK: `auth-mechanical-surface-constants` against firebase-js-sdk 12.13.0, replayed value-for-value in `unit:oracle-conformance.test.ts`. This matters more than it looks: consumer code COMPARES against these constants, so a mirror that got a string wrong would turn every such comparison into a silent `false` — a worse failure than the export simply being absent, because it typechecks and runs. NOTE: the capture's `persistenceTypes` block is deliberately NOT asserted — the harness runs under Node, where firebase/auth stubs the browser-only persistence tokens to `type: 'NONE'` (it reports 'NONE' even for `browserLocalPersistence`, which is unambiguously 'LOCAL'); asserting it would be asserting a harness artifact. See auth#178. |
| 173 | Throws `auth/invalid-custom-token` for a malformed token and for the empty string. The sandbox accepts a token in the two shapes it can honestly read: a JSON (optionally base64url) `{uid, claims}` payload — exactly what `admin.auth().createCustomToken` signs, so the pyric-admin mint and this redeem compose — or a real three-part JWT whose payload segment carries `uid`/`sub`. The SIGNATURE IS NOT VERIFIED: the sandbox has no service-account key. The identity is created if it does not exist, and the credential carries `providerId: null` (custom-token sign-in is not a federated provider). | ⚠ | ORACLE-BACKED on the reject path: `auth-signinwithcustomtoken-invalid` captured `auth/invalid-custom-token` for both a malformed token and the empty string, replayed in `unit:oracle-conformance.test.ts`. Diverged on the ACCEPT path, declared rather than hidden: prod verifies an RS256 signature against the project's service-account key and the sandbox has no key, so it reads the token's claims WITHOUT verifying them. A forged token that prod would reject is accepted here. The happy path cannot be oracle-probed from a Web SDK client at all (it needs an Admin-SDK-signed JWT). |
| 174 | Returns a `PasswordValidationStatus` against the project's password policy, WITHOUT attempting a sign-up (so a UI can show live strength feedback). The sandbox's policy is `minPasswordLength: 6`, `maxPasswordLength: 4096`, `enforcementState: 'ENFORCE'`, with every character-class requirement UNSET — so a password this function calls valid is exactly one `createUserWithEmailAndPassword` will accept. The character-class fields are `undefined`, not `false`: upstream distinguishes 'not required' from 'required and unmet', and reporting `false` would claim the password failed a rule the project never had. | ✓ | ORACLE-BACKED: `auth-validatepassword-status-shape` captured prod's live policy (minPasswordLength 6, maxPasswordLength 4096, ENFORCE, character classes unset) and the status shape for a weak and a strong password. Replayed in `unit:oracle-conformance.test.ts`. The 6-char minimum agrees with the separately oracle-pinned `auth/weak-password` threshold on the create path, so the two surfaces draw the same line here exactly as they do in prod. |
| 175 | NOT MIRRORED — the one genuinely out-of-scope symbol in the auth surface. Deprecated upstream as a SECURITY RETRACTION: the shipped `@firebase/auth` declaration states the API 'returns an empty list when Email Enumeration Protection is enabled, irrespective of the number of authentication methods available for the given email', and that 'migrating off of this method is recommended as a security best-practice'. Enumeration protection is on by default, so against a modern project the production function always returns `[]`. | — | DISPOSITION, with the reasoning recorded: mirroring it would mean either reproducing a function that always returns nothing (a no-op that misleads whoever calls it) or implementing the pre-deprecation behavior the sandbox COULD provide — which would be strictly worse, because agent code would work against the mirror and then silently get `[]` in prod and take the wrong branch. A mirror that is MORE capable than production here is a trap, not a feature. Same criterion the two-tier policy already applies to Imagen in `firebase/ai`. The disposition rests on the SDK's own type declaration (a primary source), NOT on the oracle probe: `auth-fetchsigninmethodsforemail-deprecated` came back `auth/operation-not-allowed` because the oracle project has the Email/Password provider disabled, and that capture proves nothing either way. Deny-list entry (tier `out-of-scope`) in `packages/conformance/src/surface-denylist.ts`. |
| 178 | Inert configuration tokens, accepted so the idiomatic `initializeAuth(app, { persistence: indexedDBLocalPersistence })` and `setPersistence(auth, browserCookiePersistence)` compile, run, and behave identically. The `.type` discriminant matches upstream exactly (`NONE` / `SESSION` / `LOCAL` / `LOCAL` / `COOKIE`) because consumer code branches on it. `browserPopupRedirectResolver` is accepted and ignored — the sandbox has its own first-class pluggable equivalent (`sandbox.setAuthFlowResolver`). `prodErrorMap` is accepted and DELIBERATELY not honored: installing it upstream strips error messages, and doing that in a sandbox whose purpose is to tell a developer what went wrong would be actively hostile. | ⚠ | In an in-memory sandbox the persistence CHOICE has no observable consequence, so accepting the token and recording the mode is the honest behavior — the same inert-token pattern `pyric/firestore` uses for its cache-factory tokens. `unit:types.test.ts` + `unit:sandbox-email-link.test.ts` cover the exports. Oracle caveat recorded on auth#172: the `persistenceTypes` block of `auth-mechanical-surface-constants` reports `NONE` for every token including `browserLocalPersistence` — a Node-build stub artifact, not the browser contract, so the `.type` values here follow the documented `Persistence.type` union instead. |
| 179 | Accepted no-op. In production this reaches OUTSIDE Firebase entirely — it tells the identity provider (in practice Apple) to revoke an OAuth access token, which is a call landing on Apple's servers. There is no external IdP behind a sandbox sign-in, so there is no token out there to revoke and nothing this call could truthfully do. It resolves (so the account-deletion flow Apple requires an app to ship runs end to end against the sandbox) and changes no sandbox state (because claiming otherwise would be a lie). | ⚠ | `unit:types.test.ts` — the export resolves. Deliberately not oracle-probed: a successful probe would revoke a real token at a real IdP, which is a side effect on someone else's system that a conformance run has no business causing. |
| 180 | Real classes, not markers. `EmailAuthProvider.credential(email, password)` returns an `EmailAuthCredential` that CARRIES THE SECRET — which is what makes `linkWithCredential`, `reauthenticateWithCredential`, and `signInWithCredential` decidable in the sandbox with no resolver and no mock (the backend already stores and verifies passwords). `credentialWithLink` carries the link instead, and `signInMethod` discriminates (`'password'` vs `'emailLink'`). The backing secret is non-enumerable, so a spread or `Object.keys` walk does not pick it up; `toJSON()` DOES carry it, matching upstream (whose `fromJSON` needs it to round-trip). `OAuthCredential` carries the IdP tokens, which the sandbox cannot verify — those flows keep going through the resolver seam. | ✓ | `unit:sandbox-linking-reauth.test.ts` — pins the secret-carrying behavior, the enumerable/toJSON split (so nobody 'hardens' it into a divergence later), and that a real email credential now signs in via `signInWithCredential` instead of throwing the sandbox-only `auth/no-mock-configured` it used to. |
| 181 | Provider marker classes. `TwitterAuthProvider.credential(token, secret)` takes a token AND a secret — Twitter is the one OAuth 1.0a provider in the set, where the OAuth 2.0 providers take a single access token. `SAMLAuthProvider`'s constructor ENFORCES the `saml.` providerId prefix (throwing `auth/argument-error` otherwise), because that id is what routes an assertion to the right configured IdP and a typo there would silently target nothing. SAML has no client-constructible credential, so the class has no `credential()` factory. | ✓ | `unit:types.test.ts` — construction, PROVIDER_ID values, and the SAML prefix guard. |
| 182 | One entry PER LINKED PROVIDER, read from the identity's stored record. Previously the sandbox synthesized a single `{providerId: 'password'}` entry for EVERY non-anonymous user, so a Google popup sign-in reported its provider as `'password'` and a linked account could never show more than one. Consumer code branches on this array (that is what it is for — 'is this account linked to Google?'), so the synthesized version was actively misleading. Empty for anonymous users; after `unlink` of the last provider it is genuinely empty (it does not resurrect the removed provider). | ✓ | Was a BUG until this climb, and worth naming as one: the array was fabricated, not read. Now fixed and locked. `unit:sandbox-linking-reauth.test.ts` now pins that a Google link surfaces `google.com` in `providerData`, that `unlink` shrinks it, and that unlinking the last provider leaves it empty rather than falling back to a synthesized `'password'` entry. |

## Deny-list (intentionally NOT shimmed)

These exist in `firebase/auth` but the sandbox does not mirror them.

The list is much shorter than it was. The auth resolver climb removed three whole
families from it — account linking (`linkWith*` / `unlink`), re-authentication
(`reauthenticateWith*`), and the email-link / action-code family
(`sendSignInLinkToEmail`, `signInWithEmailLink`, `applyActionCode`, `ActionCodeURL`, …) —
by building them, not by re-arguing them. Their old reasons ("v0 scope", "email-link
flows require an SMTP path") were never good ones: mocking external infrastructure is
the product, and needing an inbox is not the same as being unmodelable.

| Name | Reason |
|---|---|
| `fetchSignInMethodsForEmail` | **Out of scope, not deferred.** Deprecated upstream as a security retraction: the shipped `@firebase/auth` declaration says it "returns an empty list when Email Enumeration Protection is enabled, irrespective of the number of authentication methods available", and that "migrating off of this method is recommended as a security best-practice". Enumeration protection is on by default, so in a modern project the production function always returns `[]`. Mirroring the pre-deprecation behavior would make the sandbox MORE capable than prod — agent code would work here and then silently take the wrong branch in production. See row #175. |
| `multiFactor(user)` / MFA / phone / reCAPTCHA APIs | Deferred, not out of scope — reCAPTCHA and SMS are external infrastructure pyric can mock through the same resolver seam the OAuth and email families now use, and TOTP is pure algorithm work. |
| `updatePhoneNumber` | Deferred with the rest of the phone family. |
| `setLanguageCode` (Auth method) | i18n surface. (`useDeviceLanguage` is mirrored as an accepted no-op.) |
| `User.toJSON()` | Serialization the sandbox doesn't model (AUTH-GAP). (`User.reload()` / `User.delete()` are mirrored via the top-level `reload(user)` / `deleteUser(user)`.) |
| `User.metadata` / `User.refreshToken` / `User.tenantId` | Not tracked by the sandbox; documented per AUTH-GAP. |
| Positional listener `error` / `complete` args on `onAuthStateChanged` / `onIdTokenChanged` | Sandbox observers never error/complete (synchronous in-memory fan-out); pass the `{ next, error, complete }` observer object if you need those handlers. Production listener behavior remains owned by the unchanged `firebase/auth` import. |

---

## What the oracle could not reach, and why

Recorded here because a coverage number that hides its own blind spots is worth less
than a smaller one that names them.

**The oracle project currently has the Email/Password sign-in provider DISABLED.**
Anonymous sign-in works; every email/password path returns `auth/operation-not-allowed`.
That blocked oracle-backing for the linking and reauthentication families outright (an
email credential cannot be minted there at all) and for the server-side half of the
email-link family. Those probes were still written, still run, and their captures are
still committed — showing `auth/operation-not-allowed` — rather than being quietly
dropped. The rows they would have backed are born `unit-backed` and say so in their
evidence column. See the `NOT_APPLICABLE` block in
`packages/pyric/test/auth/oracle-conformance.test.ts`.

This also means the EXISTING email/password observations in this surface
(`auth-row-18-invalid-email`, `auth-row-19-weak-password`, `auth-email-already-in-use`,
`auth-user-not-found`, `auth-wrong-password`, …) can no longer be RE-captured against
this project. They were captured when the provider was on; re-running the rig today
would fail them. That is pre-existing infrastructure decay, surfaced here, not caused
by this climb.

To lift the whole set to oracle-backed: enable Email/Password sign-in on the oracle
project (Authentication -> Sign-in method) and re-run the probes, which are already
written and committed.

**Genuinely unobservable, for anyone.** No probe and no test can read a human's inbox.
The email round trip is therefore closed in the sandbox by the mail outbox
(`sandbox.takeAuthMail`), which hands the program the same real, single-use code a
human would have clicked — the analog of `mockSignInResult` for the email family. What
IS fully observable, and is oracle-pinned exactly, is the pure client-side half:
the `ActionCodeURL` parse contract, the `isSignInWithEmailLink` predicate, and the
`ActionCodeSettings` validation — none of which touch a network at all.

---

## Visible gaps to address next

Rows currently marked **?** (need explicit probes):

- #3 canonical production package resolution — landing once the
  empirical oracle harness (`packages/conformance/src/run.ts`) captures the
  observation against a real Firebase project. Harness is in
  place; needs the `PYRIC_ORACLE_FIREBASE_CONFIG` env var pointed
  at a dedicated oracle project before observations can be
  committed. See `packages/conformance/docs/oracle-project-setup.md` for project setup.
- #69 (ordering only) — disabled-vs-wrong-password precedence on
  `signInWithEmailAndPassword`. Sandbox checks disabled BEFORE the
  password compare (anti-probing best-known semantics); needs an
  oracle capture against a disabled prod account to lock the order.
- #68 (prod side) — `IdTokenResult.signInProvider` values per flow are
  documented SDK behavior but not yet oracle-captured.

Rows **locked by the empirical oracle harness** (committed observations under `packages/conformance/observations/auth/`, captured against the `blockingfun` project):

- #10 `onAuthStateChanged` exactly-one-per-transition — oracle confirmed signIn → signOut → signIn each produced exactly 1 fire (in addition to the initial null fire on subscribe); sandbox matches.
- #14 `signInWithEmailAndPassword` user-not-found — oracle confirmed prod still emits `auth/user-not-found` (not the newer `auth/invalid-credential`); sandbox matches.
- #17 `signInWithEmailAndPassword` fires once with the new user — oracle confirmed `firesForSignIn: 1` with the signed-in uid against prod; sandbox matches.
- #18 `auth/invalid-email` format-validation — oracle confirmed `createUserWithEmailAndPassword(auth, 'not-an-email', …)` throws `auth/invalid-email` against prod; sandbox now matches (validation lives in `sandbox-backend.ts` and runs before user-DB lookup on both `signIn` and `createUser` paths).
- #19 `auth/weak-password` strength-validation — oracle confirmed prod rejects 3-char passwords with `auth/weak-password` and message `Password should be at least 6 characters`; sandbox now matches the same 6-char threshold (validated on `createUser` only — `signIn` lets in previously-seeded weak passwords, mirroring prod).
- #24 `createUserWithEmailAndPassword` fires once with the new user — oracle confirmed `firesForCreate: 1` with the newly-created uid against prod; sandbox matches.
- #26 `signOut` fires null exactly once — oracle confirmed the signOut transition produced exactly 1 fire with `uid === null`; sandbox matches.
- #30 `onAuthStateChanged` on every subsequent identity change — oracle confirmed signIn → signOut → signIn → signOut all 4 fired exactly once; sandbox matches.
- #32 `Unsubscribe` removes the observer — oracle confirmed post-unsubscribe signOut+signIn+signOut produced zero further fires; sandbox matches.
- #33 multiple subscribers all fire — oracle confirmed two listeners registered back-to-back both fire on each transition; sandbox matches.
- #36 observer object form (`{next, error, complete}`) — oracle confirmed prod accepts both forms; both fire on every transition; sandbox matches.
- #21 `createUserWithEmailAndPassword` `operationType` — oracle confirmed prod returns `'signIn'` (NOT `'register'`); sandbox matches.
- #22 `createUserWithEmailAndPassword` duplicate email — oracle confirmed prod emits `auth/email-already-in-use`; sandbox matches.
- #25 `signOut` synchronous-null — oracle confirmed prod sets `auth.currentUser` to `null` in the synchronous continuation immediately after `await signOut(auth)` resolves; sandbox matches.
- #27 `signOut` idempotent — oracle confirmed prod is a no-op, no listener fire on the redundant call.
- #29 `onAuthStateChanged` initial-fire timing — oracle confirmed prod fires the initial value on the microtask after subscribe, not synchronously; sandbox matches.
- #31 `onAuthStateChanged` no-dup on sync transition — oracle baseline: prod has no synchronous state-change API, so the dedup case is sandbox-only. Async subscribe + signIn produces two natural fires (initial null, then user).
- #35 `onAuthStateChanged` throwing-observer isolation — oracle confirmed a throwing observer does not block subsequent observers; sandbox matches.
- #37 `onAuthStateChanged` same-user no-double-fire — oracle confirmed calling `signInAnonymously` twice in a row returns the same uid and the second call does NOT produce a fresh listener fire; sandbox matches.
- #38 `onIdTokenChanged` user-change fires — oracle confirmed every signIn/signOut transition produces exactly one fire; sandbox matches.
- #39 `onIdTokenChanged` on forced refresh — oracle confirmed prod fires the listener after `getIdToken(true)`; sandbox matches (divergence closed).
- #40 `onIdTokenChanged` initial-fire parity with `onAuthStateChanged` — oracle confirmed both listeners share the microtask-deferred initial-fire timing; sandbox matches.
- #55 `getIdToken(forceRefresh)` — oracle confirmed prod returns a different token string after a forced refresh and a subsequent non-forced read returns the cached new token; sandbox matches (divergence closed).

Rows currently marked **—** that we might want to fill (rough priority):

1. #20-23 `updateProfile` — common app pattern, agent code often calls it
2. #57 `user.emailVerified` — used by gating logic in real apps
3. #58-61 `user.metadata` / `reload` / `delete` — full User shape parity

Rows currently marked **⚠** that we might want to upgrade to **✓**
(by aligning the sandbox to prod or by formally documenting the
divergence in `feature-matrix.md`):

- #7 anonymous uid format
- #12, #28 persistence story
- #43 setPersistence respect
- #48 popup window
