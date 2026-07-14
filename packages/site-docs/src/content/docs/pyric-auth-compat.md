---
title: "pyric/auth compatibility matrix"
navLabel: "Auth"
group: "Conformance"
section: ""
order: 8004
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/auth` compatibility matrix

> **Surface coverage:** 82.4% of Firebase's public exports · 83.3% of what pyric intends to mirror
>
> **Fidelity:** 80.7% (96 of 119 tracked claims match production)
>
> Coverage is about whether the export exists. Fidelity is about whether each claimed interaction matches production Firebase — see the [scoreboard](../pyric-conformance-scores/) for what that percentage does and does not mean.

The single readable contract for "what this shim guarantees vs the
production `firebase/auth` SDK."

See the design rationale for the methodology (vocabulary
of conformance / oracle / matrix; how to add rows; how the runner
attributes failures).

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — sandbox matches prod, locked by a passing probe</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match prod but doesn't; failing probe pins it</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — not implemented yet (deliberately or pending)</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — claim from docs that we haven't yet observed prod-side</span>
</div>

Probe references: `playground:<name>` means a fixture under
`packages/playground/scripts/fixtures/<name>.tsx`. `unit:<file>`
means a Bun test in `packages/auth/test/<file>`.

---

## `getAuth(target)` — initializer

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns a stable <code>Auth</code> handle for repeat calls with the same sandbox or sandbox-backed <code>PyricApp</code> — one backend and handle per sandbox</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code> + canonical Node register child (<code>register-child.test.ts</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getAuth(sandbox)</code> dispatches to the sandbox backend</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Without sandbox package swapping, canonical <code>firebase/auth</code> imports remain Firebase and never enter this mirror</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Direct mirror rejection is locked by <code>unit:package-resolution.test.ts</code>; an unswapped production-resolution observation is still needed</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After package swapping, bare <code>getAuth()</code> resolves the registered default sandbox app; without swapping, Firebase retains its <code>app/no-app</code> behavior when no default app exists</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">canonical Node register child (<code>register-child.test.ts</code>) + oracle: <code>packages/conformance/observations/auth/auth-bare-getauth-no-default-app.json</code> (<code>code: 'app/no-app'</code> against blockingfun, fb-js-sdk 12.13.0 — confirms unswapped Firebase behavior)</div>
<div class="compat-note">(wrap)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>auth.currentUser</code> is a live getter, not a snapshot — reads through to the backend on every access</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">implicit in <code>unit:sandbox-anonymous.test.ts</code></div></div>
</details>
</div>

## `signInAnonymously(auth)` — anonymous

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns <code>UserCredential</code> with <code>providerId: null</code>, <code>operationType: 'signIn'</code>, and a <code>User</code> with <code>isAnonymous: true</code>, <code>email: null</code>, <code>displayName: null</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-6-anon-credential-shape</code> (one-claim) + oracle: <code>packages/conformance/observations/auth/auth-anonymous-credential-providerid.json</code> (<code>providerId: null</code> against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said <code>providerId: 'anonymous'</code>; corrected after empirical observation. Sandbox aligned to prod in the same commit.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Auto-generates a uid for fresh sign-ins (sandbox format: <code>anonymous-{N}</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code> — prod uids are 28-char base64-ish; sandbox uses a readable counter for debuggability</div>
<div class="compat-note">format</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">If an anonymous user is already signed in, returns the SAME user (no fresh uid mint)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code> ("idempotent while signed in") — fix from #399</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After <code>signOut</code>, a subsequent <code>signInAnonymously</code> mints a fresh uid</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-9-anon-fresh-uid-after-signout</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires <code>onAuthStateChanged</code> exactly once per state transition (no same-value double-fire)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-10-onauthstatechanged-one-per-transition</code> (one-claim) — fix from #399 + oracle: <code>packages/conformance/observations/auth/auth-row-10-onauthstatechanged-one-per-transition.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial null fire → <code>signInAnonymously</code> → +1 → <code>signOut</code> → +1 → <code>signInAnonymously</code> → +1. <code>eachTransitionFiredExactlyOnce: true</code> — every transition produces exactly one fire)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Writes through to <code>sandbox.currentUser</code> so rules engines see <code>request.auth.uid</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-11-anon-uid-visible-to-rules</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Anonymous users persist across page reload via configured <code>Persistence</code> (prod only — sandbox has no persistence layer)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox memory only; within one tab the user persists, across reload they don't</div></div>
</details>
</div>

## `signInWithEmailAndPassword(auth, email, password)` — password

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns <code>UserCredential</code> with <code>providerId: null</code> (NOT <code>'password'</code> — only OAuth/phone responses carry a providerId; upstream <code>providerIdForResponse</code> returns null for email/password), <code>operationType: 'signIn'</code>, and a <code>User</code> with the stored uid + email</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-createUser-operationType.json</code> (<code>providerId: null</code> against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said <code>providerId: 'password'</code>; corrected after the oracle contradicted it (AUTH-B2).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Throws <code>auth/user-not-found</code> when the email isn't seeded / hasn't been created</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-user-not-found-error-code.json</code> (<code>code: 'auth/user-not-found'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Throws <code>auth/wrong-password</code> when the password doesn't match</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code>, <code>playground:auth-email-password</code> (bundled) + <code>playground:auth-row-15-wrong-password-rejects</code> (one-claim) + oracle: <code>packages/conformance/observations/auth/auth-wrong-password-error-code.json</code> (<code>code: 'auth/wrong-password'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">An EMPTY password throws <code>auth/missing-password</code> (message "A non-empty password must be provided"), fired before the user-DB lookup so it can't be used to enumerate seeded emails. Upstream maps the <code>MISSING_PASSWORD</code> server error (<code>core/errors.ts:92,282,563</code>). ⚠ best-known semantics — message text not yet captured against a live project (STOP-flagged for an oracle pass; the <code>.code</code> is the load-bearing part).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-cluster-b9-b12.test.ts</code> (locks AUTH-B11)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Re-signing in after <code>signOut</code> returns the <strong>same</strong> uid (passwords persist within the sandbox lifetime)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-email-password</code> (bundled) + <code>playground:auth-row-16-resignin-same-uid</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires <code>onAuthStateChanged</code> with the new user once</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-17-signin-email-password-fires-once.json</code> (against blockingfun, fb-js-sdk 12.13.0: createUser → signOut → subscribe (1 initial null fire) → <code>signInWithEmailAndPassword</code> → <code>firesForSignIn: 1</code> with the signed-in uid, <code>lastFireUidMatches: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Email validation (RFC 5322ish) — rejects empty, missing <code>@</code>, missing local-part, missing domain with <code>auth/invalid-email</code>. Runs on both <code>signInWithEmailAndPassword</code> and <code>createUserWithEmailAndPassword</code> before any user-DB lookup, so consumers shipping malformed input see the same error sandbox vs prod.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-18-invalid-email-error-code.json</code> (<code>code: 'auth/invalid-email'</code>, message <code>Firebase: Error (auth/invalid-email).</code> against blockingfun, fb-js-sdk 12.13.0)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Password strength requirements — rejects passwords shorter than 6 chars with <code>auth/weak-password</code> on <code>createUserWithEmailAndPassword</code>. Strength is NOT enforced on <code>signInWithEmailAndPassword</code> so previously-seeded weak passwords still let the user in (matches prod's separation of registration vs sign-in).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-19-weak-password-error-code.json</code> (<code>code: 'auth/weak-password'</code>, message <code>Firebase: Password should be at least 6 characters (auth/weak-password).</code> against blockingfun, fb-js-sdk 12.13.0; matrix language "≥6 chars per prod default" empirically confirmed)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Disabled accounts (<code>sandbox.updateUser(…, {disabled: true})</code>) reject sign-in with <code>auth/user-disabled</code> and prod's documented message (<code>The user account has been disabled by an administrator.</code>). Sandbox checks disabled BEFORE the password compare (anti-probing); the exact prod ordering of disabled-vs-wrong-password needs an oracle capture</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("disabled users")</div>
<div class="compat-note">code / ? ordering</div></div>
</details>
</div>

## `createUserWithEmailAndPassword(auth, email, password)` — register

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Creates a new user, signs them in automatically (currentUser becomes the new user)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-email-password</code> (bundled) + <code>playground:auth-row-20-create-user-auto-signs-in</code> (one-claim), <code>unit:sandbox-email-password.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns <code>UserCredential</code> with <code>operationType: 'signIn'</code> (NOT <code>'register'</code> — matches prod)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-createUser-operationType.json</code> (<code>operationType: 'signIn'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Throws <code>auth/email-already-in-use</code> when the email is already registered</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-email-already-in-use-error-code.json</code> (<code>code: 'auth/email-already-in-use'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The created user has <code>isAnonymous: false</code>, <code>email: &lt;input&gt;</code>, <code>displayName: null</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + <code>playground:auth-row-23-create-user-shape</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires <code>onAuthStateChanged</code> with the new user once</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-24-createuser-fires-once.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → <code>createUserWithEmailAndPassword</code> → <code>firesForCreate: 1</code> with the newly-created uid, <code>lastFireUidMatches: true</code>)</div></div>
</details>
</div>

## `signOut(auth)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Sets <code>currentUser</code> to <code>null</code> synchronously after resolution</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-25-signout-currentuser-null</code> (one-claim), <code>unit:sandbox-anonymous.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-25-signout-currentuser-null-sync.json</code> (<code>currentUserIsNullSync: true</code> against blockingfun, fb-js-sdk 12.13.0 — <code>auth.currentUser</code> read in the synchronous continuation immediately after <code>await signOut(auth)</code> is already <code>null</code>, with no microtask/macrotask required to settle)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires <code>onAuthStateChanged</code> with <code>null</code> exactly once</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-26-signout-fires-null-once</code> (one-claim) + oracle: <code>packages/conformance/observations/auth/auth-row-26-signout-fires-null-once.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → <code>signInAnonymously</code> → <code>signOut</code> → <code>firesForSignOut: 1</code> with <code>lastFireUidWasNull: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Idempotent — <code>signOut</code> on already-signed-out user is a no-op (no listener fire)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-signout-idempotent</code> + oracle-confirmed: <code>packages/conformance/observations/auth/auth-signout-idempotent.json</code> (<code>threw: false, redundantSignOutFiredListener: false</code> against blockingfun)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Clears the active session's persistence in prod; sandbox has no persistence</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: same memory-only constraint as the anonymous persistence row</div></div>
</details>
</div>

## `onAuthStateChanged(auth, observer)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires immediately on subscribe with the current value (microtask-deferred)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-29-onauthstatechanged-initial-fire-timing.json</code> (<code>firedSynchronously: 0, firedAfterMicrotask: 1</code> against blockingfun, fb-js-sdk 12.13.0 — initial fire does NOT arrive in the synchronous tick of <code>onAuthStateChanged(...)</code>; it lands after the first microtask flush)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires on every subsequent identity change</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-anonymous</code> + oracle: <code>packages/conformance/observations/auth/auth-row-30-onauthstatechanged-fires-on-every-transition.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → <code>signIn</code> → <code>signOut</code> → <code>signIn</code> → <code>signOut</code>, each of the 4 transitions produced exactly 1 fire; <code>eachTransitionFiredExactlyOnce: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Dedups by uid: a same-uid update (profile-shape change, or a same-uid re-sign-in) does NOT re-fire <code>onAuthStateChanged</code> — only an actual uid change does. Mirrors upstream <code>notifyAuthListeners</code>'s <code>lastNotifiedUid</code> gate (<code>auth_impl.ts:718-723</code>). (<code>onIdTokenChanged</code> still fires on those same-uid updates — see row 38a.)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-uid-dedup.test.ts</code> (locks AUTH-B7 / B8)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><strong>No duplicate fire</strong> when subscribe is followed by a synchronous <code>setCurrentUser</code> — dedup ensures observer sees the new value once, not twice. Sandbox-only concern: prod has no synchronous state-change API, so the dedup window can't be exercised against the cloud SDK; subscribe-then-async-signIn naturally fires twice (initial + new value) because the microtask between them flushes the initial fire</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> (regression test from #399), <code>playground:auth-anonymous</code> + oracle baseline: <code>packages/conformance/observations/auth/auth-row-31-onauthstatechanged-no-dup-on-sync-transition.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe + async <code>signInAnonymously</code> in the same tick produces <code>totalFires: 2</code> — <code>{uid: null, ts: 0}</code> then <code>{uid: &lt;user&gt;, ts: ~400ms}</code>. Confirms prod cannot exhibit the same-tick race; the dedup behavior remains a sandbox-only property)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returned <code>Unsubscribe</code> removes the observer; subsequent state changes do NOT fire it</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-listener-unsub</code> (bundled) + <code>playground:auth-row-32-unsubscribe-stops-fires</code> (one-claim) + oracle: <code>packages/conformance/observations/auth/auth-row-32-unsubscribe-stops-fires.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 fire on <code>signInAnonymously</code> → call <code>unsub()</code> → <code>signOut</code> + <code>signInAnonymously</code> + <code>signOut</code> produce zero further fires; <code>postUnsubFires: 0, unsubscribeStoppedFires: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Multiple subscribers all fire on each change</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-33-multiple-subscribers-all-fire.json</code> (against blockingfun, fb-js-sdk 12.13.0: two subscribers registered back-to-back each see 1 initial null fire, +1 on <code>signInAnonymously</code>, +1 on <code>signOut</code>; <code>bothFiredOnSignIn: true, bothFiredOnSignOut: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Registry is array-backed (matches upstream <code>util/subscribe.ts</code>): the SAME observer fn registered N times produces N independent registrations that each fire, and one <code>Unsubscribe</code> removes exactly one registration. A resubscribe of a previously-unsubscribed fn fires its initial value again. (Per-registration initial-fire bookkeeping, not a shared per-observer dedup.)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listener-registry.test.ts</code> (locks AUTH-B3 + AUTH-B4)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Unsubscribing during emission does not skip remaining subscribers (snapshotted iteration)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A throwing observer doesn't block other observers from firing</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-35-throwing-observer-doesnt-block-others.json</code> (<code>secondObserverContinuedFiring: true</code> against blockingfun, fb-js-sdk 12.13.0 — observer #1 throws on every call, observer #2 still counts the initial fire AND the post-sign-in fire)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Observer object form (<code>{next, error, complete}</code>) works alongside the function form</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-36-observer-object-form-works.json</code> (against blockingfun, fb-js-sdk 12.13.0: one observer as <code>NextFn</code>, another as <code>{next, error, complete}</code>. Both forms see 1 initial null fire, +1 on <code>signInAnonymously</code>, +1 on <code>signOut</code>; <code>bothFormsFiredOnSignIn: true, bothFormsFiredOnSignOut: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Setting the same user twice does NOT double-fire (structural-equality no-op). Sandbox-internal <code>setCurrentUser</code> claim; the prod analog is <code>signInAnonymously</code> called twice in a row (per fix #399, the second call returns the same user).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-37-same-user-no-double-fire.json</code> (against blockingfun, fb-js-sdk 12.13.0: first <code>signInAnonymously</code> fires the listener once; second call returns the same uid (<code>sameUserAcrossCalls: true</code>) and does NOT produce a fresh fire (<code>secondSignInProducedFire: false</code>). Prod also recognizes the same-user no-op)</div></div>
</details>
</div>

## `onIdTokenChanged(auth, observer)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires on user change (sandbox shares the auth-state path)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-38-onidtokenchanged-fires-on-user-change.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial fire (null) → <code>signInAnonymously</code> → +1 (user₁) → <code>signOut</code> → +1 (null) → <code>signInAnonymously</code> → +1 (user₂ with fresh uid). Every identity transition produces exactly one fire, matching <code>onAuthStateChanged</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires on EVERY sign-in, including a same-uid re-sign-in (no <code>signOut</code> first) — which mints a fresh token, so a subsequent <code>getIdToken()</code> returns a new string. Mirrors upstream <code>notifyAuthListeners</code>, which calls <code>idTokenSubscription.next</code> on every identity update (<code>auth_impl.ts:716</code>). <code>onAuthStateChanged</code> stays silent on the same-uid case (row 30a).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-uid-dedup.test.ts</code> (locks AUTH-B8)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires on token refresh (<code>getIdToken(true)</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-token-refresh.test.ts</code> — was ⚠ (documented divergence); aligned to prod in commit — sandbox now mints a fresh token on forceRefresh and fires <code>onIdTokenChanged</code> (NOT <code>onAuthStateChanged</code>, since identity is unchanged). Oracle: <code>packages/conformance/observations/auth/auth-onidtokenchanged-force-refresh.json</code> defines the target shape (<code>refreshFiredListener: true</code> against blockingfun; subscribe → null fire → <code>signInAnonymously</code> → +1 → <code>getIdToken(true)</code> → +1 for a total of 3 fires).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Initial-fire semantics match <code>onAuthStateChanged</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>packages/conformance/observations/auth/auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribing both listeners in the same tick yields <code>sync: {auth: 0, idToken: 0}</code> → <code>microtask: {auth: 1, idToken: 1}</code> → no further fires. Both listeners share the microtask-deferred initial-fire timing)</div></div>
</details>
</div>

## `setPersistence(auth, persistence)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Accepts <code>inMemoryPersistence</code> / <code>browserSessionPersistence</code> / <code>browserLocalPersistence</code> markers without throwing</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:types.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns <code>Promise&lt;void&gt;</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:types.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Actually changes where the auth state is persisted</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox is a no-op. Prod respects the marker.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">An unrecognized persistence marker is rejected with <code>auth/argument-error</code> rather than silently coerced to LOCAL</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-cluster-b9-b12.test.ts</code> (locks AUTH-B12)</div></div>
</details>
</div>

## `signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns the pre-staged <code>UserCredential</code> registered via <code>sandbox.mockSignInResult(auth, …)</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Throws <code>auth/no-mock-configured</code> when no mock is pre-staged</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Mock is consumed after one read (subsequent call without a fresh stage throws again)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After successful sign-in, <code>currentUser</code> becomes the mock's <code>user</code>, listeners fire</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The credential's rich <code>User</code> (email / displayName / isAnonymous) survives the transition — popup/redirect/credential/<code>setUser</code> do NOT clobber it down to the bare <code>AuthState</code>; <code>cred.user === auth.currentUser</code> (reference identity, matches upstream <code>_updateCurrentUser(userCredential.user)</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-identity.test.ts</code> (locks AUTH-B1)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Opens a popup window in prod</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox skips the popup; mock pre-stage replaces the popup result</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Cancels with <code>auth/popup-closed-by-user</code> when the user dismisses the popup (prod)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">not modeled — would require the host to expose a "cancel" affordance on the mock</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Provider-flow sign-ins (popup / redirect / credential) record the flow's <code>providerId</code> on the identity in the user DB (upsert for unknown uids; append-if-missing for known ones) and reject disabled accounts with <code>auth/user-disabled</code> before any state change</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("provider tracking", "disabled users") — provider recording is sandbox bookkeeping for <code>listIdentities</code>/<code>listUsers</code>; prod's auto-link semantics are narrower (same-email Google auto-link only) and not modeled</div></div>
</details>
</div>

## `signInWithRedirect` / `getRedirectResult` / resolver seam

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>signInWithRedirect(auth, provider, resolver?)</code> resolves the flow (per-call resolver → injected → one-shot mock → <code>auth/argument-error</code>), signs the user in, and stashes the credential for one <code>getRedirectResult</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getRedirectResult(auth)</code> returns the stashed credential once, then <code>null</code> (one-shot, matches prod)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>sandbox.setAuthFlowResolver(auth, resolver | null)</code> installs / clears the popup/redirect resolver (the analog of browser <code>getAuth</code> wiring <code>browserPopupRedirectResolver</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>sandbox.listIdentities(auth)</code> snapshots every seeded/created identity for a host account-picker (sandbox-only — no <code>firebase/auth</code> equivalent)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
</div>

## `Auth` surface + error shape

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>auth.signOut()</code> method form works alongside the free <code>signOut(auth)</code> function (<code>firebase/auth</code>'s <code>Auth</code> exposes both) (AUTH-GAP)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Sandbox auth errors are real <code>FirebaseError</code> instances (<code>err instanceof FirebaseError</code>) carrying the prod message wrapper <code>Firebase: &lt;message&gt; (&lt;auth/...&gt;).</code> — e.g. <code>Firebase: Error (auth/invalid-email).</code>, matching the oracle (AUTH-GAP)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
</div>

## Provider classes (`GoogleAuthProvider`, `EmailAuthProvider`, etc.)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Exports the same constructor signatures as <code>firebase/auth</code> for each provider</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">type-only smoke in <code>unit:types.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>Provider.credential(...)</code> static factories produce <code>AuthCredential</code>-shaped objects</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>GoogleAuthProvider.providerId === 'google.com'</code> (and per-provider analogs)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Custom scopes / params / language code</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">sandbox ignores; prod forwards</div></div>
</details>
</div>

## `User` methods

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.getIdToken()</code> returns a stable opaque token in sandbox (<code>sandbox-id-token-…</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.getIdToken(true)</code> (forceRefresh) returns a NEW token; subsequent <code>getIdToken(false)</code> returns the cached new token</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-token-refresh.test.ts</code> — was ⚠ (documented divergence); aligned to prod in commit — sandbox now mints a fresh token on forceRefresh and fires <code>onIdTokenChanged</code>. Oracle: <code>packages/conformance/observations/auth/auth-getidtoken-force-refresh.json</code> defines the target shape (<code>forceRefreshReturnedDifferentString: true</code>, <code>token1EqualsToken2: true</code> against blockingfun — the refreshed token is cached, so a subsequent non-forced read returns it, not yet another fresh one). Sandbox tokens stay <code>sandbox-id-token-&lt;uid&gt;-&lt;hash&gt;</code> strings; prod's are real JWTs.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.getIdTokenResult()</code> returns claims</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code> (custom-claims path)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.uid</code>, <code>user.email</code>, <code>user.displayName</code>, <code>user.isAnonymous</code> reflect the source</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-anonymous</code>, <code>playground:auth-email-password</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.emailVerified</code> — present on every sandbox-minted <code>User</code> (default <code>false</code>; sandbox has no verification flow). Prod passes the real value through (no longer stripped). The admin record (<code>sandbox.listUsers</code>) carries it too</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code> (locks AUTH-GAP)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.photoURL</code> / <code>user.phoneNumber</code> — present (sandbox default <code>null</code>; prod passes through, no longer stripped)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>user.providerId</code> (aggregate, <code>'firebase'</code>) + <code>user.providerData: UserInfo[]</code> — sandbox synthesizes one provider entry for non-anonymous users, empty for anonymous; prod passes the real array through (no longer stripped). The admin record carries the emulator-shaped <code>providerUserInfo</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior"><code>user.metadata.creationTime</code> / <code>lastSignInTime</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">client <code>User.metadata</code> not exposed (AUTH-GAP); the admin record carries <code>createdAt</code>/<code>lastLoginAt</code> (ISO)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>IdTokenResult.signInProvider</code> reflects the session's provider per flow (<code>'anonymous'</code> / <code>'password'</code> / <code>'google.com'</code> / …); claims include the reserved <code>firebase.sign_in_provider</code> (custom claims can't shadow it)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("IdTokenResult.signInProvider") — prod shape is documented SDK behavior; no oracle capture yet</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Custom-claims changes (<code>sandbox.updateUser</code> / re-seed) reach an active session on the next FORCED token refresh, not immediately — claims are read live from the user DB at mint time (prod's refresh-propagation story; AUTH-B10)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code>, <code>unit:sandbox-cluster-b9-b12.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior"><code>user.reload()</code> / <code>user.delete()</code> / <code>user.toJSON()</code> / <code>user.refreshToken</code> / <code>user.tenantId</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">not modeled by the sandbox; documented in the deny-list rather than synthesized (AUTH-GAP)</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior"><code>updateProfile(user, {displayName, photoURL})</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented</div></div>
</details>
</div>

## `beforeAuthStateChanged(auth, callback, onAbort?)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Registers a BLOCKING gate that runs before a real sign-in/sign-out transition commits. Callbacks run in registration order; a callback that throws (or returns a rejected promise) aborts the transition entirely: the pending <code>signInWith…</code>/<code>signOut</code> call rejects with <code>auth/login-blocked</code>, <code>currentUser</code> is unchanged, and <code>onAuthStateChanged</code>/<code>onIdTokenChanged</code> do NOT fire. Covers every sign-in path that exists in <code>pyric/auth</code>: <code>signInAnonymously</code>, <code>signInWithEmailAndPassword</code>, <code>createUserWithEmailAndPassword</code>, <code>signInWithPopup</code>, <code>signInWithRedirect</code>, <code>signInWithCredential</code>, and <code>signOut</code> (pyric has no <code>signInWithCustomToken</code> yet). Modeled after the real <code>@firebase/auth</code> <code>AuthMiddlewareQueue.runMiddleware</code> (<code>auth_impl.ts</code>), read directly from the installed SDK source, not just its <code>.d.ts</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> — implementation cross-checked against <code>@firebase/auth</code>'s <code>AuthMiddlewareQueue</code> source (registration-order queue, per-callback try/await, <code>auth/login-blocked</code> wrap). No live-oracle capture (no observable client-visible signal to probe beyond the documented+sourced contract already read).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onAbort</code> semantics: when a callback throws, every <code>onAbort</code> registered by a callback that ALREADY SUCCEEDED in the same pass runs, in REVERSE registration order — matches upstream's rollback-stack (<code>runMiddleware</code>'s <code>onAbortStack</code>). An <code>onAbort</code> that itself throws is swallowed so it can't mask the original block reason or skip the remaining rollbacks.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> ("onAbort runs (in reverse order)…", "a callback whose own onAbort throws…")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Fires on BOTH directions: a real sign-in (<code>nextUser</code> non-null) and a real sign-out (<code>nextUser === null</code>) — a throwing callback blocks <code>signOut</code> too, leaving the previous user signed in. Matches upstream, where the same middleware queue gates <code>_updateCurrentUser</code> and <code>signOut</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> ("fires on sign-out too…")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>sandbox.setUser</code> (the sandbox-only test driver) BYPASSES the gate entirely — it is a raw identity force with no prod analog (same bypass it already has for provider enforcement / <code>signInProvider</code> tracking), so no registered <code>beforeAuthStateChanged</code> callback runs and none can block it.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> ("sandbox.setUser test driver bypasses the gate")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Served-worker path (SharedWorker-backed auth in <code>@pyric/cli</code>): the worker owns the shared user pool and commits transitions on its own side of the port, so a page-local <code>beforeAuthStateChanged</code> registration can't actually gate a worker-driven sign-in. Rather than silently accept a callback that could never run, registering THROWS immediately (<code>auth/operation-not-supported-in-this-environment</code>) — same defensive pattern as <code>signInWithCredential</code> over the worker.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>packages/cli/src/serve/worker/client.ts</code> (<code>beforeAuthStateChanged</code> throws <code>makeUnsupported</code>)</div></div>
</details>
</div>

## User-management and session exports

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Aliases <code>getAuth(app)</code> and returns the same stable <code>Auth</code> handle — an app that calls <code>initializeAuth</code> instead of <code>getAuth</code> gets an equivalent, working instance. The optional <code>Dependencies</code> arg (persistence / popupRedirectResolver) is accepted for signature parity but not applied (persistence is already a documented sandbox no-op). Repeated calls return the cached handle rather than throwing <code>auth/already-initialized</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — returns the same instance as <code>getAuth</code>, with a live <code>currentUser</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Deletes the account from the user store AND signs the user out if they are current (fires <code>onAuthStateChanged(null)</code>), matching prod where deleting the signed-in user clears <code>auth.currentUser</code>. Real behavior: a subsequent <code>signInWithEmailAndPassword</code> for that identity throws <code>auth/user-not-found</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — user removed from the store, sign-out fired, re-sign-in throws <code>auth/user-not-found</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Changes the stored email (via the same path as <code>sandbox.updateUser</code>, rejecting <code>auth/email-already-in-use</code> / <code>auth/invalid-email</code>) and mutates the held <code>user</code> in place, so the next sign-in resolves against the new email. Leniency vs prod: the sandbox does NOT enforce <code>auth/requires-recent-login</code> and is not routed through <code>verifyBeforeUpdateEmail</code> (which the real SDK requires when email-enumeration protection is on)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — stored email changes; re-sign-in works with the new email, fails with the old</div>
<div class="compat-note">email really changes; no requires-recent-login / verifyBeforeUpdateEmail enforcement</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Sets the stored password (validated for strength). The sandbox DOES store and verify passwords, so this is a real mutation: a subsequent <code>signInWithEmailAndPassword</code> with the new password succeeds and the old one throws <code>auth/wrong-password</code>. Leniency vs prod: no <code>auth/requires-recent-login</code> enforcement</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — new password signs in, old password throws <code>auth/wrong-password</code></div>
<div class="compat-note">password really changes + is verified; no requires-recent-login enforcement</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Re-reads the stored record into the <code>user</code> object in place, so a change made out of band (e.g. <code>sandbox.updateUser</code>) is reflected on the held reference — matching prod's server refresh. Users not tracked in the DB (anonymous / popup) have nothing to refresh (safe no-op)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — an out-of-band <code>sandbox.updateUser</code> displayName change is visible on the held user after <code>reload</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Sets the sandbox's current user (pass <code>null</code> to sign out), firing <code>onAuthStateChanged</code> — <code>auth.currentUser</code> reflects the passed user afterward</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — <code>auth.currentUser</code> becomes the passed user; <code>null</code> signs out</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Accepted no-op — the sandbox has no device locale to read, so there is no language to set; accepted so init code that calls it compiles + runs</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:fruit-aliases.test.ts</code> — resolves/returns without error</div>
<div class="compat-note">no device locale in the sandbox</div></div>
</details>
</div>

## `ActionCodeURL` / email-link / action-code — the out-of-band family

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Parses an out-of-band action link. The <code>mode</code> query param maps to a NORMALIZED operation (<code>mode=resetPassword</code> -&gt; <code>PASSWORD_RESET</code>, <code>mode=signIn</code> -&gt; <code>EMAIL_SIGNIN</code>), <code>oobCode</code> surfaces as <code>code</code>, <code>lang</code> as <code>languageCode</code>, and <code>continueUrl</code> comes out URL-DECODED. A link missing <code>mode</code>, missing <code>oobCode</code>, carrying an unknown mode, or that is not a URL at all parses to <code>null</code> — the parse NEVER throws. <code>parseActionCodeURL</code> and <code>ActionCodeURL.parseLink</code> agree.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED and project-independent: this is a PURE client-side parse (no network, no project, no mailbox), so the sandbox owes prod an exact match and there is no room for a divergence. Oracle: <code>auth-actioncodeurl-parse</code> against firebase-js-sdk 12.13.0. Replayed in <code>unit:oracle-conformance.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Pure predicate over the link string — no network. <code>true</code> only for a link whose mode is <code>signIn</code> AND which carries an <code>oobCode</code>; <code>false</code> for a password-reset link, for <code>mode=signIn</code> with no code, for garbage, and for the empty string. Never throws.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED, project-independent (no server involved): <code>auth-issigninwithemaillink-predicate</code> captured all five cases against prod. Replayed in <code>unit:oracle-conformance.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Redeems an out-of-band code and performs its state change (<code>VERIFY_EMAIL</code> sets <code>emailVerified</code>, <code>VERIFY_AND_CHANGE_EMAIL</code> moves the account to the new address). Throws <code>auth/invalid-action-code</code> for a code the project never issued, for the empty string, and for a code already redeemed (single-use). A <code>PASSWORD_RESET</code> code is refused — <code>confirmPasswordReset</code> owns that one.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the reject path: <code>auth-action-code-invalid</code> confirmed prod emits <code>auth/invalid-action-code</code> for both a bogus code and the empty string (this endpoint is NOT gated on the password provider, so it answered honestly). The APPLY path (a real code, redeemed) cannot be probed from a client — it needs a code from a real inbox — and is unit-backed end to end against the sandbox outbox in <code>unit:sandbox-email-link.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">ActionCodeSettings validation, enforced CLIENT-side before any request leaves the process: a missing or unparseable <code>url</code> throws <code>auth/invalid-continue-uri</code> (NOT <code>auth/missing-continue-uri</code>, despite the constant's name), and <code>handleCodeInApp</code> other than <code>true</code> throws <code>auth/argument-error</code>. On success the sandbox mints a single-use code and posts the message to the outbox.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on both client-side arms (project-independent — prod threw before any network call): <code>auth-sendsigninlinktoemail-settings-validation</code> captured <code>missingUrl: auth/invalid-continue-uri</code> and <code>handleCodeInAppFalse: auth/argument-error</code>. Replayed in <code>unit:oracle-conformance.test.ts</code>; the send path is unit-backed in <code>unit:sandbox-email-link.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Redeems the code in a sign-in link. A link carrying no <code>oobCode</code> throws <code>auth/argument-error</code> CLIENT-side (the SDK never reaches the server to ask about a code it cannot find in the link). A first-time sign-in for an address CREATES the account, <code>getAdditionalUserInfo(cred).isNewUser</code> is <code>true</code>, and the account arrives <code>emailVerified: true</code> — redeeming a code mailed to that address is proof of control. The code is single-use.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the client-side reject (<code>auth-signinwithemaillink-invalid-link</code>: <code>noOobCode: auth/argument-error</code>). The REDEMPTION path could not be probed: the oracle project has email-link sign-in disabled, so the server arm answered <code>auth/operation-not-allowed</code>. That half is unit-backed end to end against the sandbox outbox (<code>unit:sandbox-email-link.test.ts</code> drives send -&gt; read the outbox -&gt; sign in).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">For an address NO account owns, prod RESOLVES silently — it does not throw <code>auth/user-not-found</code>. Email Enumeration Protection is on by default and refusing to leak account existence is the point. The sandbox matches: it resolves and mails nothing. A malformed address still throws <code>auth/invalid-email</code>. For a real account, the sandbox mails a reset code; <code>confirmPasswordReset</code> redeems it and the new password signs in while the old one throws <code>auth/wrong-password</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the enumeration-protection behavior — the fact most likely to be got wrong: <code>auth-sendpasswordresetemail-unknown-user</code> captured <code>resolvedForUnknownUser: true</code>, <code>unknownUserCode: null</code>, <code>malformedEmailCode: auth/invalid-email</code>. A shim that threw <code>auth/user-not-found</code> here would hand agent code an account oracle production deliberately removed. Reset round trip unit-backed in <code>unit:sandbox-email-link.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Throws <code>auth/missing-email</code> for a user with no email on the account (an anonymous user). For a real account the mail goes out and NOTHING ELSE HAPPENS: <code>user.emailVerified</code> stays <code>false</code>. Verification happens when the code in the message is redeemed (<code>applyActionCode</code>), not when it is sent.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the anonymous reject: <code>auth-sendemailverification-shape</code> captured <code>anonymousUserCode: auth/missing-email</code> against prod. The send-does-not-verify property is the one the whole flow turns on and is unit-backed (<code>unit:sandbox-email-link.test.ts</code> asserts <code>emailVerified</code> is still false after the send and true only after the code is applied) — it cannot be oracle-confirmed end to end because confirming it would require reading a real inbox.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Mails a code to the NEW address and returns. The account's email does NOT change until that code is redeemed — the single guarantee separating this API from a bare <code>updateEmail</code>: the user must prove control of the new address before it becomes theirs. On redemption the account moves and the new address arrives <code>emailVerified: true</code>. <code>checkActionCode</code> on the code reports <code>data.email</code> = the new address and <code>data.previousEmail</code> = the old one.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">UNIT-BACKED, not oracle-backed, and the reason is recorded rather than hidden: the probe (<code>auth-verifybeforeupdateemail-shape</code>) ran against the real project and came back <code>auth/operation-not-allowed</code> on every arm, because the oracle project has the Email/Password provider DISABLED and the probe could not even create the user whose email it would change. The capture is committed showing exactly that. Behavior is proven end to end against the sandbox in <code>unit:sandbox-email-link.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The sandbox IS the mail server. Every send posts a real message (operation, recipient, single-use code, and the full action link) to an outbox; <code>sandbox.takeAuthMail</code> reads it — the program's substitute for a human opening an inbox. The mailed link round-trips through the public <code>isSignInWithEmailLink</code> / <code>parseActionCodeURL</code> unchanged, and its code is the code the redeemer accepts, so the round trip production cannot complete without a human closes in-process. An installed <code>AuthMailResolver</code> is additionally notified per message; a resolver that THROWS does not fail the send that produced it.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-link.test.ts</code> — sandbox-only driver (no <code>firebase/auth</code> counterpart; this is the seam that makes the family testable at all).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>checkActionCode</code> and <code>verifyPasswordResetCode</code> INSPECT a code without burning it — a check must not destroy the code the subsequent apply needs. <code>confirmPasswordReset</code> redeems it and sets the password, running the same strength check <code>createUserWithEmailAndPassword</code> runs; a weak new password throws <code>auth/weak-password</code> and does NOT burn the code (a typo must not destroy the user's one reset link). A code staged as expired throws <code>auth/expired-action-code</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">UNIT-BACKED, stated honestly: these three endpoints answered <code>auth/operation-not-allowed</code> in the oracle run (<code>auth-action-code-invalid</code>) because the oracle project's disabled password provider replies before the invalid-code contract can. That is a fact about the project's configuration, not about the API, so it is NOT asserted as evidence. The error codes used here are matched to the oracle-CAPTURED <code>AuthErrorCodes</code> map (<code>INVALID_OOB_CODE = auth/invalid-action-code</code>, <code>EXPIRED_OOB_CODE = auth/expired-action-code</code> — see auth#172). Behavior proven in <code>unit:sandbox-email-link.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Prod rejects a continue URL whose domain is not on the project's authorized-domains list. The sandbox has NO domain allowlist and does not invent one: it accepts any parseable continue URL. A continue URL that would be rejected in production is accepted here.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">The sandbox has no project config to hold an authorized-domains list, so there is nothing to check against; inventing an allowlist would mean inventing a policy the user never set. The probe attempted the server arm (<code>auth-sendsigninlinktoemail-settings-validation</code>, <code>unauthorizedDomain</code>) but the oracle project has email-link sign-in disabled, so it answered <code>auth/operation-not-allowed</code> rather than <code>auth/unauthorized-continue-uri</code> — the divergence is declared from the documented contract, not from a capture we do not have.</div></div>
</details>
</div>

## `linkWithCredential` / `linkWithPopup` / `linkWithRedirect` / `unlink` — account linking

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The ANONYMOUS UPGRADE. Linking an email credential onto an anonymous account upgrades it IN PLACE: the uid is PRESERVED, <code>isAnonymous</code> flips to <code>false</code>, the email is set, and <code>providerData</code> gains the provider. Preserving the uid is what keeps the data the user created while anonymous theirs. Returns a <code>UserCredential</code> with <code>operationType: 'link'</code> and <code>getAdditionalUserInfo().isNewUser === false</code> (a link never creates an identity). The linked credential then works as a first-class <code>signInWithEmailAndPassword</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">UNIT-BACKED, not oracle-backed — stated plainly. The probe (<code>auth-link-email-credential-to-anonymous</code>) ran against the real project and returned <code>linkCode: auth/operation-not-allowed</code>: the oracle project has the Email/Password provider DISABLED, so no email credential can be minted there and the flow cannot be reached. The capture is committed showing exactly that rather than being dropped. Behavior proven in <code>unit:sandbox-linking-reauth.test.ts</code>, including the uid-preservation invariant.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>auth/provider-already-linked</code> when the account already carries the provider (one identity per provider). <code>auth/email-already-in-use</code> when the email credential belongs to a DIFFERENT account — an address can back only one identity, so the link cannot be granted without stealing it.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">UNIT-BACKED. The probe (<code>auth-link-conflicts</code>) ran and every arm returned <code>auth/operation-not-allowed</code> (same disabled Email/Password provider on the oracle project), so the conflict codes could not be observed against prod. They are matched instead to the oracle-CAPTURED <code>AuthErrorCodes</code> map (<code>PROVIDER_ALREADY_LINKED = auth/provider-already-linked</code>, <code>CREDENTIAL_ALREADY_IN_USE = auth/credential-already-in-use</code> — auth#172) and proven in <code>unit:sandbox-linking-reauth.test.ts</code>. NOTE: for an EMAIL credential the sandbox emits <code>auth/email-already-in-use</code>, the code prod uses for an address collision; <code>credential-already-in-use</code> remains the OAuth-credential case.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Detaches a provider and returns the updated user with a SHRUNKEN <code>providerData</code>. Unlinking a provider that was never linked throws <code>auth/no-such-provider</code>. Unlinking <code>'password'</code> takes the password with it, so <code>signInWithEmailAndPassword</code> for that account stops working. Unlinking the LAST provider does NOT re-anonymize the account — <code>isAnonymous</code> describes how an identity was born, not what it currently carries.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the reject path — the ONE linking fact the oracle could reach, because it needs no email credential: <code>auth-unlink-provider</code> captured <code>noSuchProviderCode: auth/no-such-provider</code> against prod on an anonymous user. Replayed in <code>unit:oracle-conformance.test.ts</code>. The detach path is unit-backed (<code>unit:sandbox-linking-reauth.test.ts</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Route through the SAME <code>AuthFlowResolver</code> seam as <code>signInWithPopup</code>, with <code>authType: 'link'</code> on the request so a host UI can present 'link your Google account' rather than 'sign in'. The resolved credential names the provider to attach; the sandbox performs the attach and the uid is preserved. A disabled provider throws <code>auth/operation-not-allowed</code> AHEAD of the resolver check — a code deliberately distinct from <code>auth/argument-error</code>, which keeps meaning 'enabled, but no resolver/mock wired'.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-linking-reauth.test.ts</code> — asserts the resolver sees <code>authType: 'link'</code>, the uid is preserved, and the two error codes stay distinct. The OAuth arm cannot be oracle-probed at all (it needs a real IdP popup and a human), which is precisely why it goes through the resolver seam.</div></div>
</details>
</div>

## `reauthenticateWithCredential` / `reauthenticateWithPopup` / `reauthenticateWithRedirect` — re-authentication

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Really re-verifies: an email credential is checked against the stored password exactly as <code>signInWithEmailAndPassword</code> checks it. A wrong password throws <code>auth/wrong-password</code>. A credential belonging to a DIFFERENT account throws <code>auth/user-mismatch</code> — checked BEFORE the password compare, so it cannot leak whether the other account's password was right. On success a fresh ID token is minted (a new <code>authTime</code>), and the returned <code>UserCredential</code> carries <code>operationType: 'reauthenticate'</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">UNIT-BACKED, and the reason it is not oracle-backed is recorded rather than glossed: the probe (<code>auth-reauthenticate-with-credential</code>) ran against the real project and could not even create the two accounts it needs — <code>setupCode: auth/operation-not-allowed</code>, because the oracle project has the Email/Password provider DISABLED. The capture is committed showing that. <code>auth/user-mismatch</code> is matched to the oracle-captured <code>AuthErrorCodes</code> map (auth#172). Behavior proven in <code>unit:sandbox-linking-reauth.test.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">In production the POINT of re-authentication is the <code>auth/requires-recent-login</code> gate: <code>updateEmail</code> / <code>updatePassword</code> / <code>deleteUser</code> refuse to run on a session whose sign-in is older than a few minutes, and re-auth is how you clear it. The sandbox does NOT enforce that gate — those three mutations already run on a session of any age (a pre-existing documented divergence), so there is no gate here for re-auth to clear. What re-auth DOES do here is real but narrower: it genuinely re-verifies the credential, mints a fresh token, and returns <code>operationType: 'reauthenticate'</code>. Code that calls it runs unchanged against prod, where it also clears the gate.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Declared divergence, not a bug: inventing a recent-login gate would break every existing sandbox flow (which never re-authenticates) while proving nothing. <code>unit:sandbox-linking-reauth.test.ts</code> pins the behavior that IS provided (real credential re-verification + a fresh token).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Route through the shared resolver seam with <code>authType: 'reauth'</code>. The identity the resolver produces MUST be the user being re-authenticated — a resolver that hands back a different uid throws <code>auth/user-mismatch</code>. That check is the entire security content of the flow; without it 're-authentication' would accept anyone.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-linking-reauth.test.ts</code> — asserts the resolver sees <code>authType: 'reauth'</code> and that an impostor identity is rejected with <code>auth/user-mismatch</code>.</div></div>
</details>
</div>

## Constants, credentials, and inert config tokens

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns <code>{ isNewUser, profile, providerId }</code>. For a fresh anonymous sign-in prod reports <code>{ isNewUser: true, providerId: null, profile: {} }</code> — <code>providerId</code> is NULL, not <code>'anonymous'</code>, because anonymous is not a federated provider. <code>isNewUser</code> is <code>true</code> for <code>createUserWithEmailAndPassword</code>, a first-time email-link sign-in, and a custom-token sign-in that minted the account; <code>false</code> for a returning <code>signInWithEmailAndPassword</code> and for every <code>link</code> / <code>reauthenticate</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the anonymous shape: <code>auth-additional-user-info-shape</code> captured <code>{isNewUser: true, providerId: null, profile: {}}</code> against prod. Replayed in <code>unit:oracle-conformance.test.ts</code>. The email/password arms of the probe were blocked by the oracle project's disabled password provider and are unit-backed instead.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The constant maps, value for value. <code>OperationType.SIGN_IN === 'signIn'</code>, <code>SignInMethod.EMAIL_LINK === 'emailLink'</code>, <code>ProviderId.GOOGLE === 'google.com'</code>, <code>ActionCodeOperation.PASSWORD_RESET === 'PASSWORD_RESET'</code>, and the 106-entry <code>AuthErrorCodes</code> map (<code>INVALID_OOB_CODE === 'auth/invalid-action-code'</code>, <code>PROVIDER_ALREADY_LINKED === 'auth/provider-already-linked'</code>, <code>NO_SUCH_PROVIDER === 'auth/no-such-provider'</code>, <code>USER_MISMATCH === 'auth/user-mismatch'</code>, …).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED, snapshotted straight from the shipped SDK: <code>auth-mechanical-surface-constants</code> against firebase-js-sdk 12.13.0, replayed value-for-value in <code>unit:oracle-conformance.test.ts</code>. This matters more than it looks: consumer code COMPARES against these constants, so a mirror that got a string wrong would turn every such comparison into a silent <code>false</code> — a worse failure than the export simply being absent, because it typechecks and runs. NOTE: the capture's <code>persistenceTypes</code> block is deliberately NOT asserted — the harness runs under Node, where firebase/auth stubs the browser-only persistence tokens to <code>type: 'NONE'</code> (it reports 'NONE' even for <code>browserLocalPersistence</code>, which is unambiguously 'LOCAL'); asserting it would be asserting a harness artifact. See auth#178.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Throws <code>auth/invalid-custom-token</code> for a malformed token and for the empty string. The sandbox accepts a token in the two shapes it can honestly read: a JSON (optionally base64url) <code>{uid, claims}</code> payload — exactly what <code>admin.auth().createCustomToken</code> signs, so the pyric-admin mint and this redeem compose — or a real three-part JWT whose payload segment carries <code>uid</code>/<code>sub</code>. The SIGNATURE IS NOT VERIFIED: the sandbox has no service-account key. The identity is created if it does not exist, and the credential carries <code>providerId: null</code> (custom-token sign-in is not a federated provider).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED on the reject path: <code>auth-signinwithcustomtoken-invalid</code> captured <code>auth/invalid-custom-token</code> for both a malformed token and the empty string, replayed in <code>unit:oracle-conformance.test.ts</code>. Diverged on the ACCEPT path, declared rather than hidden: prod verifies an RS256 signature against the project's service-account key and the sandbox has no key, so it reads the token's claims WITHOUT verifying them. A forged token that prod would reject is accepted here. The happy path cannot be oracle-probed from a Web SDK client at all (it needs an Admin-SDK-signed JWT).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns a <code>PasswordValidationStatus</code> against the project's password policy, WITHOUT attempting a sign-up (so a UI can show live strength feedback). The sandbox's policy is <code>minPasswordLength: 6</code>, <code>maxPasswordLength: 4096</code>, <code>enforcementState: 'ENFORCE'</code>, with every character-class requirement UNSET — so a password this function calls valid is exactly one <code>createUserWithEmailAndPassword</code> will accept. The character-class fields are <code>undefined</code>, not <code>false</code>: upstream distinguishes 'not required' from 'required and unmet', and reporting <code>false</code> would claim the password failed a rule the project never had.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">ORACLE-BACKED: <code>auth-validatepassword-status-shape</code> captured prod's live policy (minPasswordLength 6, maxPasswordLength 4096, ENFORCE, character classes unset) and the status shape for a weak and a strong password. Replayed in <code>unit:oracle-conformance.test.ts</code>. The 6-char minimum agrees with the separately oracle-pinned <code>auth/weak-password</code> threshold on the create path, so the two surfaces draw the same line here exactly as they do in prod.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">NOT MIRRORED — the one genuinely out-of-scope symbol in the auth surface. Deprecated upstream as a SECURITY RETRACTION: the shipped <code>@firebase/auth</code> declaration states the API 'returns an empty list when Email Enumeration Protection is enabled, irrespective of the number of authentication methods available for the given email', and that 'migrating off of this method is recommended as a security best-practice'. Enumeration protection is on by default, so against a modern project the production function always returns <code>[]</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">DISPOSITION, with the reasoning recorded: mirroring it would mean either reproducing a function that always returns nothing (a no-op that misleads whoever calls it) or implementing the pre-deprecation behavior the sandbox COULD provide — which would be strictly worse, because agent code would work against the mirror and then silently get <code>[]</code> in prod and take the wrong branch. A mirror that is MORE capable than production here is a trap, not a feature. Same criterion the two-tier policy already applies to Imagen in <code>firebase/ai</code>. The disposition rests on the SDK's own type declaration (a primary source), NOT on the oracle probe: <code>auth-fetchsigninmethodsforemail-deprecated</code> came back <code>auth/operation-not-allowed</code> because the oracle project has the Email/Password provider disabled, and that capture proves nothing either way. Deny-list entry (tier <code>out-of-scope</code>) in <code>packages/conformance/src/surface-denylist.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Inert configuration tokens, accepted so the idiomatic <code>initializeAuth(app, { persistence: indexedDBLocalPersistence })</code> and <code>setPersistence(auth, browserCookiePersistence)</code> compile, run, and behave identically. The <code>.type</code> discriminant matches upstream exactly (<code>NONE</code> / <code>SESSION</code> / <code>LOCAL</code> / <code>LOCAL</code> / <code>COOKIE</code>) because consumer code branches on it. <code>browserPopupRedirectResolver</code> is accepted and ignored — the sandbox has its own first-class pluggable equivalent (<code>sandbox.setAuthFlowResolver</code>). <code>prodErrorMap</code> is accepted and DELIBERATELY not honored: installing it upstream strips error messages, and doing that in a sandbox whose purpose is to tell a developer what went wrong would be actively hostile.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">In an in-memory sandbox the persistence CHOICE has no observable consequence, so accepting the token and recording the mode is the honest behavior — the same inert-token pattern <code>pyric/firestore</code> uses for its cache-factory tokens. <code>unit:types.test.ts</code> + <code>unit:sandbox-email-link.test.ts</code> cover the exports. Oracle caveat recorded on auth#172: the <code>persistenceTypes</code> block of <code>auth-mechanical-surface-constants</code> reports <code>NONE</code> for every token including <code>browserLocalPersistence</code> — a Node-build stub artifact, not the browser contract, so the <code>.type</code> values here follow the documented <code>Persistence.type</code> union instead.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Accepted no-op. In production this reaches OUTSIDE Firebase entirely — it tells the identity provider (in practice Apple) to revoke an OAuth access token, which is a call landing on Apple's servers. There is no external IdP behind a sandbox sign-in, so there is no token out there to revoke and nothing this call could truthfully do. It resolves (so the account-deletion flow Apple requires an app to ship runs end to end against the sandbox) and changes no sandbox state (because claiming otherwise would be a lie).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:types.test.ts</code> — the export resolves. Deliberately not oracle-probed: a successful probe would revoke a real token at a real IdP, which is a side effect on someone else's system that a conformance run has no business causing.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Real classes, not markers. <code>EmailAuthProvider.credential(email, password)</code> returns an <code>EmailAuthCredential</code> that CARRIES THE SECRET — which is what makes <code>linkWithCredential</code>, <code>reauthenticateWithCredential</code>, and <code>signInWithCredential</code> decidable in the sandbox with no resolver and no mock (the backend already stores and verifies passwords). <code>credentialWithLink</code> carries the link instead, and <code>signInMethod</code> discriminates (<code>'password'</code> vs <code>'emailLink'</code>). The backing secret is non-enumerable, so a spread or <code>Object.keys</code> walk does not pick it up; <code>toJSON()</code> DOES carry it, matching upstream (whose <code>fromJSON</code> needs it to round-trip). <code>OAuthCredential</code> carries the IdP tokens, which the sandbox cannot verify — those flows keep going through the resolver seam.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-linking-reauth.test.ts</code> — pins the secret-carrying behavior, the enumerable/toJSON split (so nobody 'hardens' it into a divergence later), and that a real email credential now signs in via <code>signInWithCredential</code> instead of throwing the sandbox-only <code>auth/no-mock-configured</code> it used to.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Provider marker classes. <code>TwitterAuthProvider.credential(token, secret)</code> takes a token AND a secret — Twitter is the one OAuth 1.0a provider in the set, where the OAuth 2.0 providers take a single access token. <code>SAMLAuthProvider</code>'s constructor ENFORCES the <code>saml.</code> providerId prefix (throwing <code>auth/argument-error</code> otherwise), because that id is what routes an assertion to the right configured IdP and a typo there would silently target nothing. SAML has no client-constructible credential, so the class has no <code>credential()</code> factory.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:types.test.ts</code> — construction, PROVIDER_ID values, and the SAML prefix guard.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">One entry PER LINKED PROVIDER, read from the identity's stored record. Previously the sandbox synthesized a single <code>{providerId: 'password'}</code> entry for EVERY non-anonymous user, so a Google popup sign-in reported its provider as <code>'password'</code> and a linked account could never show more than one. Consumer code branches on this array (that is what it is for — 'is this account linked to Google?'), so the synthesized version was actively misleading. Empty for anonymous users; after <code>unlink</code> of the last provider it is genuinely empty (it does not resurrect the removed provider).</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Was a BUG until this climb, and worth naming as one: the array was fabricated, not read. Now fixed and locked. <code>unit:sandbox-linking-reauth.test.ts</code> now pins that a Google link surfaces <code>google.com</code> in <code>providerData</code>, that <code>unlink</code> shrinks it, and that unlinking the last provider leaves it empty rather than falling back to a synthesized <code>'password'</code> entry.</div></div>
</details>
</div>

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
