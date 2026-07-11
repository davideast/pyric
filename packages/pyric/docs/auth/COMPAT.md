<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/auth` compatibility matrix

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
| 1 | Returns a stable `Auth` handle for repeat calls with the same target — idempotent on BOTH the sandbox target (per-sandbox WeakMap) and the prod target (per-resolved-`fb.Auth` WeakMap; previously the prod wrapper was minted fresh per call) | ✓ | `unit:sandbox-anonymous.test.ts` (sandbox) + `unit:prod-getauth-memo.test.ts` (prod, locks AUTH-B6) |
| 2 | `getAuth(sandbox)` dispatches to the sandbox backend | ✓ | `unit:sandbox-anonymous.test.ts` |
| 3 | `getAuth(app)` dispatches to the production backend | ? | (no prod test harness yet) |
| 4 | `getAuth(undefined)` — wrapped in the playground preview to default to the sandbox; raw call delegates to prod which throws `app/no-app` | ✓ (wrap) | `playground:firestore-bare-getfirestore` (mirrors the `getFirestore` wrap from #397) + oracle: `scripts/oracle/observations/auth-bare-getauth-no-default-app.json` (`code: 'app/no-app'` against blockingfun, fb-js-sdk 12.13.0 — confirms prod throw shape) |
| 5 | `auth.currentUser` is a live getter, not a snapshot — reads through to the backend on every access | ✓ | implicit in `unit:sandbox-anonymous.test.ts` |

## `signInAnonymously(auth)` — anonymous

| # | Behavior | Status | Probe |
|---|---|---|---|
| 6 | Returns `UserCredential` with `providerId: null`, `operationType: 'signIn'`, and a `User` with `isAnonymous: true`, `email: null`, `displayName: null` | ✓ | `unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-6-anon-credential-shape` (one-claim) + oracle: `scripts/oracle/observations/auth-anonymous-credential-providerid.json` (`providerId: null` against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said `providerId: 'anonymous'`; corrected after empirical observation. Sandbox aligned to prod in the same commit. |
| 7 | Auto-generates a uid for fresh sign-ins (sandbox format: `anonymous-{N}`) | ⚠ format | `unit:sandbox-anonymous.test.ts` — prod uids are 28-char base64-ish; sandbox uses a readable counter for debuggability |
| 8 | If an anonymous user is already signed in, returns the SAME user (no fresh uid mint) | ✓ | `unit:sandbox-anonymous.test.ts` ("idempotent while signed in") — fix from #399 |
| 9 | After `signOut`, a subsequent `signInAnonymously` mints a fresh uid | ✓ | `unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-9-anon-fresh-uid-after-signout` (one-claim) |
| 10 | Fires `onAuthStateChanged` exactly once per state transition (no same-value double-fire) | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-10-onauthstatechanged-one-per-transition` (one-claim) — fix from #399 + oracle: `scripts/oracle/observations/auth-row-10-onauthstatechanged-one-per-transition.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial null fire → `signInAnonymously` → +1 → `signOut` → +1 → `signInAnonymously` → +1. `eachTransitionFiredExactlyOnce: true` — every transition produces exactly one fire) |
| 11 | Writes through to `sandbox.currentUser` so rules engines see `request.auth.uid` | ✓ | `unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-11-anon-uid-visible-to-rules` (one-claim) |
| 12 | Anonymous users persist across page reload via configured `Persistence` (prod only — sandbox has no persistence layer) | ⚠ | divergence: sandbox memory only; within one tab the user persists, across reload they don't |

## `signInWithEmailAndPassword(auth, email, password)` — password

| # | Behavior | Status | Probe |
|---|---|---|---|
| 13 | Returns `UserCredential` with `providerId: null` (NOT `'password'` — only OAuth/phone responses carry a providerId; upstream `providerIdForResponse` returns null for email/password), `operationType: 'signIn'`, and a `User` with the stored uid + email | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `scripts/oracle/observations/auth-createUser-operationType.json` (`providerId: null` against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said `providerId: 'password'`; corrected after the oracle contradicted it (AUTH-B2). |
| 14 | Throws `auth/user-not-found` when the email isn't seeded / hasn't been created | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `scripts/oracle/observations/auth-user-not-found-error-code.json` (`code: 'auth/user-not-found'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 15 | Throws `auth/wrong-password` when the password doesn't match | ✓ | `unit:sandbox-email-password.test.ts`, `playground:auth-email-password` (bundled) + `playground:auth-row-15-wrong-password-rejects` (one-claim) + oracle: `scripts/oracle/observations/auth-wrong-password-error-code.json` (`code: 'auth/wrong-password'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 15a | An EMPTY password throws `auth/missing-password` (message "A non-empty password must be provided"), fired before the user-DB lookup so it can't be used to enumerate seeded emails. Upstream maps the `MISSING_PASSWORD` server error (`core/errors.ts:92,282,563`). ⚠ best-known semantics — message text not yet captured against a live project (STOP-flagged for an oracle pass; the `.code` is the load-bearing part). | ⚠ | `unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B11) |
| 16 | Re-signing in after `signOut` returns the **same** uid (passwords persist within the sandbox lifetime) | ✓ | `playground:auth-email-password` (bundled) + `playground:auth-row-16-resignin-same-uid` (one-claim) |
| 17 | Fires `onAuthStateChanged` with the new user once | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-17-signin-email-password-fires-once.json` (against blockingfun, fb-js-sdk 12.13.0: createUser → signOut → subscribe (1 initial null fire) → `signInWithEmailAndPassword` → `firesForSignIn: 1` with the signed-in uid, `lastFireUidMatches: true`) |
| 18 | Email validation (RFC 5322ish) — rejects empty, missing `@`, missing local-part, missing domain with `auth/invalid-email`. Runs on both `signInWithEmailAndPassword` and `createUserWithEmailAndPassword` before any user-DB lookup, so consumers shipping malformed input see the same error sandbox vs prod. | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `scripts/oracle/observations/auth-row-18-invalid-email-error-code.json` (`code: 'auth/invalid-email'`, message `Firebase: Error (auth/invalid-email).` against blockingfun, fb-js-sdk 12.13.0) |
| 19 | Password strength requirements — rejects passwords shorter than 6 chars with `auth/weak-password` on `createUserWithEmailAndPassword`. Strength is NOT enforced on `signInWithEmailAndPassword` so previously-seeded weak passwords still let the user in (matches prod's separation of registration vs sign-in). | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `scripts/oracle/observations/auth-row-19-weak-password-error-code.json` (`code: 'auth/weak-password'`, message `Firebase: Password should be at least 6 characters (auth/weak-password).` against blockingfun, fb-js-sdk 12.13.0; matrix language "≥6 chars per prod default" empirically confirmed) |
| 69 | Disabled accounts (`sandbox.updateUser(…, {disabled: true})`) reject sign-in with `auth/user-disabled` and prod's documented message (`The user account has been disabled by an administrator.`). Sandbox checks disabled BEFORE the password compare (anti-probing); the exact prod ordering of disabled-vs-wrong-password needs an oracle capture | ✓ code / ? ordering | `unit:sandbox-user-admin.test.ts` ("disabled users") |

## `createUserWithEmailAndPassword(auth, email, password)` — register

| # | Behavior | Status | Probe |
|---|---|---|---|
| 20 | Creates a new user, signs them in automatically (currentUser becomes the new user) | ✓ | `playground:auth-email-password` (bundled) + `playground:auth-row-20-create-user-auto-signs-in` (one-claim), `unit:sandbox-email-password.test.ts` |
| 21 | Returns `UserCredential` with `operationType: 'signIn'` (NOT `'register'` — matches prod) | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `scripts/oracle/observations/auth-createUser-operationType.json` (`operationType: 'signIn'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 22 | Throws `auth/email-already-in-use` when the email is already registered | ✓ | `unit:sandbox-email-password.test.ts` + oracle: `scripts/oracle/observations/auth-email-already-in-use-error-code.json` (`code: 'auth/email-already-in-use'` against blockingfun, fb-js-sdk 12.13.0; matches sandbox) |
| 23 | The created user has `isAnonymous: false`, `email: <input>`, `displayName: null` | ✓ | `unit:sandbox-email-password.test.ts` + `playground:auth-row-23-create-user-shape` (one-claim) |
| 24 | Fires `onAuthStateChanged` with the new user once | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-24-createuser-fires-once.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → `createUserWithEmailAndPassword` → `firesForCreate: 1` with the newly-created uid, `lastFireUidMatches: true`) |

## `signOut(auth)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 25 | Sets `currentUser` to `null` synchronously after resolution | ✓ | `playground:auth-anonymous` (bundled) + `playground:auth-row-25-signout-currentuser-null` (one-claim), `unit:sandbox-anonymous.test.ts` + oracle: `scripts/oracle/observations/auth-row-25-signout-currentuser-null-sync.json` (`currentUserIsNullSync: true` against blockingfun, fb-js-sdk 12.13.0 — `auth.currentUser` read in the synchronous continuation immediately after `await signOut(auth)` is already `null`, with no microtask/macrotask required to settle) |
| 26 | Fires `onAuthStateChanged` with `null` exactly once | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-26-signout-fires-null-once` (one-claim) + oracle: `scripts/oracle/observations/auth-row-26-signout-fires-null-once.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → `signInAnonymously` → `signOut` → `firesForSignOut: 1` with `lastFireUidWasNull: true`) |
| 27 | Idempotent — `signOut` on already-signed-out user is a no-op (no listener fire) | ✓ | `playground:auth-signout-idempotent` + oracle-confirmed: `scripts/oracle/observations/auth-signout-idempotent.json` (`threw: false, redundantSignOutFiredListener: false` against blockingfun) |
| 28 | Clears the active session's persistence in prod; sandbox has no persistence | ⚠ | divergence: same memory-only constraint as the anonymous persistence row |

## `onAuthStateChanged(auth, observer)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 29 | Fires immediately on subscribe with the current value (microtask-deferred) | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-29-onauthstatechanged-initial-fire-timing.json` (`firedSynchronously: 0, firedAfterMicrotask: 1` against blockingfun, fb-js-sdk 12.13.0 — initial fire does NOT arrive in the synchronous tick of `onAuthStateChanged(...)`; it lands after the first microtask flush) |
| 30 | Fires on every subsequent identity change | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` + oracle: `scripts/oracle/observations/auth-row-30-onauthstatechanged-fires-on-every-transition.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → `signIn` → `signOut` → `signIn` → `signOut`, each of the 4 transitions produced exactly 1 fire; `eachTransitionFiredExactlyOnce: true`) |
| 30a | Dedups by uid: a same-uid update (profile-shape change, or a same-uid re-sign-in) does NOT re-fire `onAuthStateChanged` — only an actual uid change does. Mirrors upstream `notifyAuthListeners`'s `lastNotifiedUid` gate (`auth_impl.ts:718-723`). (`onIdTokenChanged` still fires on those same-uid updates — see row 38a.) | ✓ | `unit:sandbox-uid-dedup.test.ts` (locks AUTH-B7 / B8) |
| 31 | **No duplicate fire** when subscribe is followed by a synchronous `setCurrentUser` — dedup ensures observer sees the new value once, not twice. Sandbox-only concern: prod has no synchronous state-change API, so the dedup window can't be exercised against the cloud SDK; subscribe-then-async-signIn naturally fires twice (initial + new value) because the microtask between them flushes the initial fire | ✓ | `unit:sandbox-listeners.test.ts` (regression test from #399), `playground:auth-anonymous` + oracle baseline: `scripts/oracle/observations/auth-row-31-onauthstatechanged-no-dup-on-sync-transition.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe + async `signInAnonymously` in the same tick produces `totalFires: 2` — `{uid: null, ts: 0}` then `{uid: <user>, ts: ~400ms}`. Confirms prod cannot exhibit the same-tick race; the dedup behavior remains a sandbox-only property) |
| 32 | Returned `Unsubscribe` removes the observer; subsequent state changes do NOT fire it | ✓ | `unit:sandbox-listeners.test.ts`, `playground:auth-listener-unsub` (bundled) + `playground:auth-row-32-unsubscribe-stops-fires` (one-claim) + oracle: `scripts/oracle/observations/auth-row-32-unsubscribe-stops-fires.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 fire on `signInAnonymously` → call `unsub()` → `signOut` + `signInAnonymously` + `signOut` produce zero further fires; `postUnsubFires: 0, unsubscribeStoppedFires: true`) |
| 33 | Multiple subscribers all fire on each change | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-33-multiple-subscribers-all-fire.json` (against blockingfun, fb-js-sdk 12.13.0: two subscribers registered back-to-back each see 1 initial null fire, +1 on `signInAnonymously`, +1 on `signOut`; `bothFiredOnSignIn: true, bothFiredOnSignOut: true`) |
| 33a | Registry is array-backed (matches upstream `util/subscribe.ts`): the SAME observer fn registered N times produces N independent registrations that each fire, and one `Unsubscribe` removes exactly one registration. A resubscribe of a previously-unsubscribed fn fires its initial value again. (Per-registration initial-fire bookkeeping, not a shared per-observer dedup.) | ✓ | `unit:sandbox-listener-registry.test.ts` (locks AUTH-B3 + AUTH-B4) |
| 34 | Unsubscribing during emission does not skip remaining subscribers (snapshotted iteration) | ✓ | `unit:sandbox-listeners.test.ts` |
| 35 | A throwing observer doesn't block other observers from firing | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-35-throwing-observer-doesnt-block-others.json` (`secondObserverContinuedFiring: true` against blockingfun, fb-js-sdk 12.13.0 — observer #1 throws on every call, observer #2 still counts the initial fire AND the post-sign-in fire) |
| 36 | Observer object form (`{next, error, complete}`) works alongside the function form | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-36-observer-object-form-works.json` (against blockingfun, fb-js-sdk 12.13.0: one observer as `NextFn`, another as `{next, error, complete}`. Both forms see 1 initial null fire, +1 on `signInAnonymously`, +1 on `signOut`; `bothFormsFiredOnSignIn: true, bothFormsFiredOnSignOut: true`) |
| 37 | Setting the same user twice does NOT double-fire (structural-equality no-op). Sandbox-internal `setCurrentUser` claim; the prod analog is `signInAnonymously` called twice in a row (per fix #399, the second call returns the same user). | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-37-same-user-no-double-fire.json` (against blockingfun, fb-js-sdk 12.13.0: first `signInAnonymously` fires the listener once; second call returns the same uid (`sameUserAcrossCalls: true`) and does NOT produce a fresh fire (`secondSignInProducedFire: false`). Prod also recognizes the same-user no-op) |

## `onIdTokenChanged(auth, observer)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 38 | Fires on user change (sandbox shares the auth-state path) | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-38-onidtokenchanged-fires-on-user-change.json` (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial fire (null) → `signInAnonymously` → +1 (user₁) → `signOut` → +1 (null) → `signInAnonymously` → +1 (user₂ with fresh uid). Every identity transition produces exactly one fire, matching `onAuthStateChanged`) |
| 38a | Fires on EVERY sign-in, including a same-uid re-sign-in (no `signOut` first) — which mints a fresh token, so a subsequent `getIdToken()` returns a new string. Mirrors upstream `notifyAuthListeners`, which calls `idTokenSubscription.next` on every identity update (`auth_impl.ts:716`). `onAuthStateChanged` stays silent on the same-uid case (row 30a). | ✓ | `unit:sandbox-uid-dedup.test.ts` (locks AUTH-B8) |
| 39 | Fires on token refresh (`getIdToken(true)`) | ✓ | `unit:sandbox-token-refresh.test.ts` — was ⚠ (documented divergence); aligned to prod in commit on branch `claude/close-auth-token-refresh` — sandbox now mints a fresh token on forceRefresh and fires `onIdTokenChanged` (NOT `onAuthStateChanged`, since identity is unchanged). Oracle: `scripts/oracle/observations/auth-onidtokenchanged-force-refresh.json` defines the target shape (`refreshFiredListener: true` against blockingfun; subscribe → null fire → `signInAnonymously` → +1 → `getIdToken(true)` → +1 for a total of 3 fires). |
| 40 | Initial-fire semantics match `onAuthStateChanged` | ✓ | `unit:sandbox-listeners.test.ts` + oracle: `scripts/oracle/observations/auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire.json` (against blockingfun, fb-js-sdk 12.13.0: subscribing both listeners in the same tick yields `sync: {auth: 0, idToken: 0}` → `microtask: {auth: 1, idToken: 1}` → no further fires. Both listeners share the microtask-deferred initial-fire timing) |

## `setPersistence(auth, persistence)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 41 | Accepts `inMemoryPersistence` / `browserSessionPersistence` / `browserLocalPersistence` markers without throwing | ✓ | `unit:types.test.ts` |
| 42 | Returns `Promise<void>` | ✓ | `unit:types.test.ts` |
| 43 | Actually changes where the auth state is persisted | ⚠ | divergence: sandbox is a no-op. Prod respects the marker. |
| 43a | An unrecognized persistence marker (not one of the three) is rejected with `auth/argument-error` on the prod backend, rather than silently coerced to LOCAL | ✓ | `unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B12) |

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
| 55 | `user.getIdToken(true)` (forceRefresh) returns a NEW token; subsequent `getIdToken(false)` returns the cached new token | ✓ | `unit:sandbox-token-refresh.test.ts` — was ⚠ (documented divergence); aligned to prod in commit on branch `claude/close-auth-token-refresh` — sandbox now mints a fresh token on forceRefresh and fires `onIdTokenChanged`. Oracle: `scripts/oracle/observations/auth-getidtoken-force-refresh.json` defines the target shape (`forceRefreshReturnedDifferentString: true`, `token1EqualsToken2: true` against blockingfun — the refreshed token is cached, so a subsequent non-forced read returns it, not yet another fresh one). Sandbox tokens stay `sandbox-id-token-<uid>-<hash>` strings; prod's are real JWTs. |
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

## `sandbox.*` (sandbox-only test driver)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 63 | `sandbox.seedUsers(auth, [{uid, email, password, displayName?, customClaims?, providerId?}])` seeds the user DB; `providerId` defaults to `'password'` | ✓ | `unit:sandbox-test-driver.test.ts`, `unit:sandbox-user-admin.test.ts` |
| 63a | Re-seeding an existing uid OVERWRITES it: a new email drops the stale email→record mapping (the old email no longer signs in), and re-seeded `customClaims` are LIVE — a held `User`'s `getIdToken(true)` reflects the new claims rather than the claims frozen at mint time | ✓ | `unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B9 + AUTH-B10) |
| 64 | `sandbox.setUser(auth, user)` / `sandbox.setUser(auth, null)` directly switches identity. Bypasses the `disabled` check and does NOT bump `lastLoginAt` (not a real sign-in) | ✓ | `unit:sandbox-test-driver.test.ts` |
| 65 | `sandbox.mockSignInResult(auth, {providerId, user, …})` pre-stages a popup/credential result | ✓ | `unit:sandbox-providers.test.ts` |
| 66 | All `sandbox.*` methods throw `failed-precondition` on prod-backed handles | ✓ | `unit:sandbox-test-driver.test.ts`, `unit:sandbox-user-admin.test.ts` |
| 67 | `sandbox.reset()` (host-side, via `Sandbox.reset()`) clears auth state and fires sign-out | ✓ | `unit:sandbox-listeners.test.ts` |
| 71 | `sandbox.listIdentities(auth)` returns the REAL provider per identity — `providerId` primary label (`'anonymous'` for anonymous users) + emulator-shaped `providerUserInfo` array; anonymous users included | ✓ | `unit:sandbox-user-admin.test.ts` ("provider tracking") — fixes the pre-epic mislabeling (`'password'`/`'anonymous'` only) |
| 72 | `sandbox.createSignInCredential(auth, {providerId, uid \| spec})` mints backend-owned credentials for host-driven flows: `{uid}` picks an existing identity (`auth/user-not-found` for unknown uids); `{spec}` upserts (same-email reuse; default uid `'<providerId>:<email>'`; no password). Tokens route through the backend token cache | ✓ | `unit:sandbox-user-admin.test.ts` ("sandbox.createSignInCredential") |
| 73 | User-admin CRUD: `sandbox.listUsers` / `createUser` (no sign-in; `auth/uid-already-exists`, `auth/email-already-in-use`, `auth/invalid-email`, `auth/weak-password`) / `updateUser` (displayName incl. null-clear, email re-key, password + provider link, customClaims wholesale replace, disabled, emailVerified) / `deleteUser` / `clearUsers`. Deletion/clear/disable do NOT terminate active sessions (prod parity). Record shape: `{uid, email, displayName, phoneNumber, photoUrl, customClaims, providerUserInfo, isAnonymous, disabled, emailVerified, createdAt, lastLoginAt}` with ISO timestamps | ✓ | `unit:sandbox-user-admin.test.ts` (CRUD describes) |
| 74 | `sandbox.subscribeUsers(auth, cb)` fires a coarse no-payload callback on every user-DB mutation (seed/create/update/delete/clear, provider links, lastLoginAt bumps); no initial fire; throwing listeners isolated; unsubscribe stops fires | ✓ | `unit:sandbox-user-admin.test.ts` ("sandbox.subscribeUsers") |

## Low-hanging-fruit exports (issue #149)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 82 | Aliases `getAuth(app)` and returns the same stable `Auth` handle — an app that calls `initializeAuth` instead of `getAuth` gets an equivalent, working instance. The optional `Dependencies` arg (persistence / popupRedirectResolver) is accepted for signature parity but not applied (persistence is already a documented sandbox no-op). Repeated calls return the cached handle rather than throwing `auth/already-initialized` | ✓ | `unit:fruit-aliases.test.ts` — returns the same instance as `getAuth`, with a live `currentUser` |
| 83 | Deletes the account from the user store AND signs the user out if they are current (fires `onAuthStateChanged(null)`), matching prod where deleting the signed-in user clears `auth.currentUser`. Real behavior: a subsequent `signInWithEmailAndPassword` for that identity throws `auth/user-not-found` | ✓ | `unit:fruit-aliases.test.ts` — user removed from the store, sign-out fired, re-sign-in throws `auth/user-not-found` |
| 84 | Changes the stored email (via the same path as `sandbox.updateUser`, rejecting `auth/email-already-in-use` / `auth/invalid-email`) and mutates the held `user` in place, so the next sign-in resolves against the new email. Leniency vs prod: the sandbox does NOT enforce `auth/requires-recent-login` and is not routed through `verifyBeforeUpdateEmail` (which the real SDK requires when email-enumeration protection is on) | ⚠ email really changes; no requires-recent-login / verifyBeforeUpdateEmail enforcement | `unit:fruit-aliases.test.ts` — stored email changes; re-sign-in works with the new email, fails with the old |
| 85 | Sets the stored password (validated for strength). The sandbox DOES store and verify passwords, so this is a real mutation: a subsequent `signInWithEmailAndPassword` with the new password succeeds and the old one throws `auth/wrong-password`. Leniency vs prod: no `auth/requires-recent-login` enforcement | ⚠ password really changes + is verified; no requires-recent-login enforcement | `unit:fruit-aliases.test.ts` — new password signs in, old password throws `auth/wrong-password` |
| 86 | Re-reads the stored record into the `user` object in place, so a change made out of band (e.g. `sandbox.updateUser`) is reflected on the held reference — matching prod's server refresh. Users not tracked in the DB (anonymous / popup) have nothing to refresh (safe no-op) | ✓ | `unit:fruit-aliases.test.ts` — an out-of-band `sandbox.updateUser` displayName change is visible on the held user after `reload` |
| 87 | Sets the sandbox's current user (pass `null` to sign out), firing `onAuthStateChanged` — `auth.currentUser` reflects the passed user afterward. Real behavior. On prod targets, hands the underlying upstream user to `firebase/auth.updateCurrentUser` | ✓ | `unit:fruit-aliases.test.ts` — `auth.currentUser` becomes the passed user; `null` signs out |
| 88 | Accepted no-op — the sandbox has no device locale to read, so there is no language to set; accepted so init code that calls it compiles + runs | ⚠ no device locale in the sandbox | `unit:fruit-aliases.test.ts` — resolves/returns without error |

## Deny-list (intentionally NOT shimmed)

These exist in `firebase/auth` but the sandbox refuses to import/use
them. The agent's writeApp prompt and the deploy bundle's metafile
gate enforce the deny-list at build time.

| Name | Reason |
|---|---|
| `linkWithCredential` / `linkWithPopup` / `linkWithRedirect` | v0 scope — account linking is non-trivial state |
| `unlink` | Same as above |
| `reauthenticateWithCredential` / `reauthenticateWithPopup` / `reauthenticateWithRedirect` | v0 scope |
| `verifyBeforeUpdateEmail` / `sendEmailVerification` / `applyActionCode` / `checkActionCode` / `confirmPasswordReset` / `sendPasswordResetEmail` / `verifyPasswordResetCode` | Email-link flows require an SMTP path; deliberately out of scope |
| `multiFactor(user)` / MFA APIs | Not modeled |
| `setLanguageCode` (Auth method) | i18n surface; not in v0. (`useDeviceLanguage` is now mirrored as an accepted no-op — issue #149.) |
| `beforeAuthStateChanged` | Blocking middleware; sandbox uses synchronous fan-out and has no equivalent yet |
| `User.toJSON()` | Serialization the sandbox doesn't model — documented per AUTH-GAP. (`User.reload()` / `User.delete()` are now mirrored via the top-level `reload(user)` / `deleteUser(user)` — issue #149.) |
| `User.metadata` / `User.refreshToken` / `User.tenantId` | Not tracked by the sandbox; documented per AUTH-GAP |
| Positional listener `error` / `complete` args on `onAuthStateChanged` / `onIdTokenChanged` | Sandbox observers never error/complete (synchronous in-memory fan-out); pass the `{ next, error, complete }` observer object if you need those handlers. The prod backend forwards all three. |

---

## Visible gaps to address next

Rows currently marked **?** (need explicit probes):

- #3 `getAuth(app)` prod-backend dispatch — landing once the
  empirical oracle harness (`scripts/oracle/run.ts`) captures the
  observation against a real Firebase project. Harness is in
  place; needs the `PYRIC_ORACLE_FIREBASE_CONFIG` env var pointed
  at a dedicated oracle project before observations can be
  committed. See `scripts/oracle/README.md` for project setup.
- #69 (ordering only) — disabled-vs-wrong-password precedence on
  `signInWithEmailAndPassword`. Sandbox checks disabled BEFORE the
  password compare (anti-probing best-known semantics); needs an
  oracle capture against a disabled prod account to lock the order.
- #68 (prod side) — `IdTokenResult.signInProvider` values per flow are
  documented SDK behavior but not yet oracle-captured.

Rows **locked by the empirical oracle harness** (committed observations under `scripts/oracle/observations/`, captured against the `blockingfun` project):

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
- #39 `onIdTokenChanged` on forced refresh — oracle confirmed prod fires the listener after `getIdToken(true)`; sandbox matches (divergence closed on branch `claude/close-auth-token-refresh`).
- #40 `onIdTokenChanged` initial-fire parity with `onAuthStateChanged` — oracle confirmed both listeners share the microtask-deferred initial-fire timing; sandbox matches.
- #55 `getIdToken(forceRefresh)` — oracle confirmed prod returns a different token string after a forced refresh and a subsequent non-forced read returns the cached new token; sandbox matches (divergence closed on branch `claude/close-auth-token-refresh`).

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
