# `pyric/auth` — maintainer notes

Moved verbatim out of `registry/auth.ts`. Not part of the site.

## What the oracle could not reach, and why

Recorded here because a coverage number that hides its own blind spots is worth less
than a smaller one that names them.

**The oracle project currently has the Email/Password sign-in provider disabled.**
Anonymous sign-in works; every email/password path returns `auth/operation-not-allowed`.
That blocked oracle-backing for the linking and reauthentication families outright (an
email credential cannot be minted there at all) and for the server-side half of the
email-link family. Those probes were still written, still run, and their captures are
still committed — showing `auth/operation-not-allowed` — rather than being quietly
dropped. The rows they would have backed are born `unit-backed` and say so in their
evidence column. See the `NOT_APPLICABLE` block in
`packages/pyric/test/auth/oracle-conformance.test.ts`.

This also means the existing email/password observations in this surface
(`auth-row-18-invalid-email`, `auth-row-19-weak-password`, `auth-email-already-in-use`,
`auth-user-not-found`, `auth-wrong-password`, …) can no longer be re-captured against
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
is fully observable, and is oracle-pinned exactly, is the pure client-side half:
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
  `signInWithEmailAndPassword`. Sandbox checks disabled before the
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
- #21 `createUserWithEmailAndPassword` `operationType` — oracle confirmed prod returns `'signIn'` (not `'register'`); sandbox matches.
- #22 `createUserWithEmailAndPassword` duplicate email — oracle confirmed prod emits `auth/email-already-in-use`; sandbox matches.
- #25 `signOut` synchronous-null — oracle confirmed prod sets `auth.currentUser` to `null` in the synchronous continuation immediately after `await signOut(auth)` resolves; sandbox matches.
- #27 `signOut` idempotent — oracle confirmed prod is a no-op, no listener fire on the redundant call.
- #29 `onAuthStateChanged` initial-fire timing — oracle confirmed prod fires the initial value on the microtask after subscribe, not synchronously; sandbox matches.
- #31 `onAuthStateChanged` no-dup on sync transition — oracle baseline: prod has no synchronous state-change API, so the dedup case is sandbox-only. Async subscribe + signIn produces two natural fires (initial null, then user).
- #35 `onAuthStateChanged` throwing-observer isolation — oracle confirmed a throwing observer does not block subsequent observers; sandbox matches.
- #37 `onAuthStateChanged` same-user no-double-fire — oracle confirmed calling `signInAnonymously` twice in a row returns the same uid and the second call does not produce a fresh listener fire; sandbox matches.
- #38 `onIdTokenChanged` user-change fires — oracle confirmed every signIn/signOut transition produces exactly one fire; sandbox matches.
- #39 `onIdTokenChanged` on forced refresh — oracle confirmed prod fires the listener after `getIdToken(true)`; sandbox matches (divergence closed).
- #40 `onIdTokenChanged` initial-fire parity with `onAuthStateChanged` — oracle confirmed both listeners share the microtask-deferred initial-fire timing; sandbox matches.
- #55 `getIdToken(forceRefresh)` — oracle confirmed prod returns a different token string after a forced refresh and a subsequent non-forced read returns the cached new token; sandbox matches (divergence closed).

Rows currently marked **—** that we might want to fill (rough priority):

1. #57 `user.emailVerified` — used by gating logic in real apps
2. #58-61 `user.metadata` / instance `User.reload`/`User.delete`/`toJSON` — full User *instance-method* shape parity (top-level `reload`/`deleteUser`/`updateProfile` are already ✓)

Rows currently marked **⚠** that we might want to upgrade to **✓**
(by aligning the sandbox to prod and updating the canonical registry
status and evidence):

- #7 anonymous uid format
- #12, #28 persistence story
- #43 setPersistence respect
- #48 popup window

