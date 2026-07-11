---
title: "pyric/auth compatibility matrix"
navLabel: "Auth"
group: "Compatibility"
section: ""
order: 31
---
<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/auth` compatibility matrix

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
<summary class="compat-line"><span class="compat-num">1</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns a stable <code>Auth</code> handle for repeat calls with the same target — idempotent on BOTH the sandbox target (per-sandbox WeakMap) and the prod target (per-resolved-<code>fb.Auth</code> WeakMap; previously the prod wrapper was minted fresh per call)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code> (sandbox) + <code>unit:prod-getauth-memo.test.ts</code> (prod, locks AUTH-B6)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">2</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getAuth(sandbox)</code> dispatches to the sandbox backend</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-num">3</span><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-behavior"><code>getAuth(app)</code> dispatches to the production backend</span></summary>
<div class="compat-evidence"><div class="compat-probe">(no prod test harness yet)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getAuth(undefined)</code> — wrapped in the playground preview to default to the sandbox; raw call delegates to prod which throws <code>app/no-app</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:firestore-bare-getfirestore</code> (mirrors the <code>getFirestore</code> wrap from #397) + oracle: <code>scripts/oracle/observations/auth-bare-getauth-no-default-app.json</code> (<code>code: 'app/no-app'</code> against blockingfun, fb-js-sdk 12.13.0 — confirms prod throw shape)</div>
<div class="compat-note">(wrap)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">5</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>auth.currentUser</code> is a live getter, not a snapshot — reads through to the backend on every access</span></summary>
<div class="compat-evidence"><div class="compat-probe">implicit in <code>unit:sandbox-anonymous.test.ts</code></div></div>
</details>
</div>

## `signInAnonymously(auth)` — anonymous

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">6</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>UserCredential</code> with <code>providerId: null</code>, <code>operationType: 'signIn'</code>, and a <code>User</code> with <code>isAnonymous: true</code>, <code>email: null</code>, <code>displayName: null</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-6-anon-credential-shape</code> (one-claim) + oracle: <code>scripts/oracle/observations/auth-anonymous-credential-providerid.json</code> (<code>providerId: null</code> against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said <code>providerId: 'anonymous'</code>; corrected after empirical observation. Sandbox aligned to prod in the same commit.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">7</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Auto-generates a uid for fresh sign-ins (sandbox format: <code>anonymous-{N}</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code> — prod uids are 28-char base64-ish; sandbox uses a readable counter for debuggability</div>
<div class="compat-note">format</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">8</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">If an anonymous user is already signed in, returns the SAME user (no fresh uid mint)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code> ("idempotent while signed in") — fix from #399</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">9</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">After <code>signOut</code>, a subsequent <code>signInAnonymously</code> mints a fresh uid</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-9-anon-fresh-uid-after-signout</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">10</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires <code>onAuthStateChanged</code> exactly once per state transition (no same-value double-fire)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-10-onauthstatechanged-one-per-transition</code> (one-claim) — fix from #399 + oracle: <code>scripts/oracle/observations/auth-row-10-onauthstatechanged-one-per-transition.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial null fire → <code>signInAnonymously</code> → +1 → <code>signOut</code> → +1 → <code>signInAnonymously</code> → +1. <code>eachTransitionFiredExactlyOnce: true</code> — every transition produces exactly one fire)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">11</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Writes through to <code>sandbox.currentUser</code> so rules engines see <code>request.auth.uid</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-11-anon-uid-visible-to-rules</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">12</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Anonymous users persist across page reload via configured <code>Persistence</code> (prod only — sandbox has no persistence layer)</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox memory only; within one tab the user persists, across reload they don't</div></div>
</details>
</div>

## `signInWithEmailAndPassword(auth, email, password)` — password

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">13</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>UserCredential</code> with <code>providerId: null</code> (NOT <code>'password'</code> — only OAuth/phone responses carry a providerId; upstream <code>providerIdForResponse</code> returns null for email/password), <code>operationType: 'signIn'</code>, and a <code>User</code> with the stored uid + email</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-createUser-operationType.json</code> (<code>providerId: null</code> against blockingfun, fb-js-sdk 12.13.0). Prior matrix language said <code>providerId: 'password'</code>; corrected after the oracle contradicted it (AUTH-B2).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">14</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>auth/user-not-found</code> when the email isn't seeded / hasn't been created</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-user-not-found-error-code.json</code> (<code>code: 'auth/user-not-found'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">15</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>auth/wrong-password</code> when the password doesn't match</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code>, <code>playground:auth-email-password</code> (bundled) + <code>playground:auth-row-15-wrong-password-rejects</code> (one-claim) + oracle: <code>scripts/oracle/observations/auth-wrong-password-error-code.json</code> (<code>code: 'auth/wrong-password'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">15a</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">An EMPTY password throws <code>auth/missing-password</code> (message "A non-empty password must be provided"), fired before the user-DB lookup so it can't be used to enumerate seeded emails. Upstream maps the <code>MISSING_PASSWORD</code> server error (<code>core/errors.ts:92,282,563</code>). ⚠ best-known semantics — message text not yet captured against a live project (STOP-flagged for an oracle pass; the <code>.code</code> is the load-bearing part).</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-cluster-b9-b12.test.ts</code> (locks AUTH-B11)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">16</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Re-signing in after <code>signOut</code> returns the <strong>same</strong> uid (passwords persist within the sandbox lifetime)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-email-password</code> (bundled) + <code>playground:auth-row-16-resignin-same-uid</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">17</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires <code>onAuthStateChanged</code> with the new user once</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-17-signin-email-password-fires-once.json</code> (against blockingfun, fb-js-sdk 12.13.0: createUser → signOut → subscribe (1 initial null fire) → <code>signInWithEmailAndPassword</code> → <code>firesForSignIn: 1</code> with the signed-in uid, <code>lastFireUidMatches: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">18</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Email validation (RFC 5322ish) — rejects empty, missing <code>@</code>, missing local-part, missing domain with <code>auth/invalid-email</code>. Runs on both <code>signInWithEmailAndPassword</code> and <code>createUserWithEmailAndPassword</code> before any user-DB lookup, so consumers shipping malformed input see the same error sandbox vs prod.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-18-invalid-email-error-code.json</code> (<code>code: 'auth/invalid-email'</code>, message <code>Firebase: Error (auth/invalid-email).</code> against blockingfun, fb-js-sdk 12.13.0)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">19</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Password strength requirements — rejects passwords shorter than 6 chars with <code>auth/weak-password</code> on <code>createUserWithEmailAndPassword</code>. Strength is NOT enforced on <code>signInWithEmailAndPassword</code> so previously-seeded weak passwords still let the user in (matches prod's separation of registration vs sign-in).</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-19-weak-password-error-code.json</code> (<code>code: 'auth/weak-password'</code>, message <code>Firebase: Password should be at least 6 characters (auth/weak-password).</code> against blockingfun, fb-js-sdk 12.13.0; matrix language "≥6 chars per prod default" empirically confirmed)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">69</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Disabled accounts (<code>sandbox.updateUser(…, {disabled: true})</code>) reject sign-in with <code>auth/user-disabled</code> and prod's documented message (<code>The user account has been disabled by an administrator.</code>). Sandbox checks disabled BEFORE the password compare (anti-probing); the exact prod ordering of disabled-vs-wrong-password needs an oracle capture</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("disabled users")</div>
<div class="compat-note">code / ? ordering</div></div>
</details>
</div>

## `createUserWithEmailAndPassword(auth, email, password)` — register

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">20</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Creates a new user, signs them in automatically (currentUser becomes the new user)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-email-password</code> (bundled) + <code>playground:auth-row-20-create-user-auto-signs-in</code> (one-claim), <code>unit:sandbox-email-password.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">21</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>UserCredential</code> with <code>operationType: 'signIn'</code> (NOT <code>'register'</code> — matches prod)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-createUser-operationType.json</code> (<code>operationType: 'signIn'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">22</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>auth/email-already-in-use</code> when the email is already registered</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-email-already-in-use-error-code.json</code> (<code>code: 'auth/email-already-in-use'</code> against blockingfun, fb-js-sdk 12.13.0; matches sandbox)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">23</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The created user has <code>isAnonymous: false</code>, <code>email: &lt;input&gt;</code>, <code>displayName: null</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-email-password.test.ts</code> + <code>playground:auth-row-23-create-user-shape</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">24</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires <code>onAuthStateChanged</code> with the new user once</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-24-createuser-fires-once.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → <code>createUserWithEmailAndPassword</code> → <code>firesForCreate: 1</code> with the newly-created uid, <code>lastFireUidMatches: true</code>)</div></div>
</details>
</div>

## `signOut(auth)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">25</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sets <code>currentUser</code> to <code>null</code> synchronously after resolution</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-25-signout-currentuser-null</code> (one-claim), <code>unit:sandbox-anonymous.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-25-signout-currentuser-null-sync.json</code> (<code>currentUserIsNullSync: true</code> against blockingfun, fb-js-sdk 12.13.0 — <code>auth.currentUser</code> read in the synchronous continuation immediately after <code>await signOut(auth)</code> is already <code>null</code>, with no microtask/macrotask required to settle)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">26</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires <code>onAuthStateChanged</code> with <code>null</code> exactly once</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-anonymous</code> (bundled) + <code>playground:auth-row-26-signout-fires-null-once</code> (one-claim) + oracle: <code>scripts/oracle/observations/auth-row-26-signout-fires-null-once.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe (1 initial null fire) → <code>signInAnonymously</code> → <code>signOut</code> → <code>firesForSignOut: 1</code> with <code>lastFireUidWasNull: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">27</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Idempotent — <code>signOut</code> on already-signed-out user is a no-op (no listener fire)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-signout-idempotent</code> + oracle-confirmed: <code>scripts/oracle/observations/auth-signout-idempotent.json</code> (<code>threw: false, redundantSignOutFiredListener: false</code> against blockingfun)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">28</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Clears the active session's persistence in prod; sandbox has no persistence</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: same memory-only constraint as the anonymous persistence row</div></div>
</details>
</div>

## `onAuthStateChanged(auth, observer)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">29</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires immediately on subscribe with the current value (microtask-deferred)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-29-onauthstatechanged-initial-fire-timing.json</code> (<code>firedSynchronously: 0, firedAfterMicrotask: 1</code> against blockingfun, fb-js-sdk 12.13.0 — initial fire does NOT arrive in the synchronous tick of <code>onAuthStateChanged(...)</code>; it lands after the first microtask flush)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">30</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires on every subsequent identity change</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-anonymous</code> + oracle: <code>scripts/oracle/observations/auth-row-30-onauthstatechanged-fires-on-every-transition.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → <code>signIn</code> → <code>signOut</code> → <code>signIn</code> → <code>signOut</code>, each of the 4 transitions produced exactly 1 fire; <code>eachTransitionFiredExactlyOnce: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">30a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Dedups by uid: a same-uid update (profile-shape change, or a same-uid re-sign-in) does NOT re-fire <code>onAuthStateChanged</code> — only an actual uid change does. Mirrors upstream <code>notifyAuthListeners</code>'s <code>lastNotifiedUid</code> gate (<code>auth_impl.ts:718-723</code>). (<code>onIdTokenChanged</code> still fires on those same-uid updates — see row 38a.)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-uid-dedup.test.ts</code> (locks AUTH-B7 / B8)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">31</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>No duplicate fire</strong> when subscribe is followed by a synchronous <code>setCurrentUser</code> — dedup ensures observer sees the new value once, not twice. Sandbox-only concern: prod has no synchronous state-change API, so the dedup window can't be exercised against the cloud SDK; subscribe-then-async-signIn naturally fires twice (initial + new value) because the microtask between them flushes the initial fire</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> (regression test from #399), <code>playground:auth-anonymous</code> + oracle baseline: <code>scripts/oracle/observations/auth-row-31-onauthstatechanged-no-dup-on-sync-transition.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe + async <code>signInAnonymously</code> in the same tick produces <code>totalFires: 2</code> — <code>{uid: null, ts: 0}</code> then <code>{uid: &lt;user&gt;, ts: ~400ms}</code>. Confirms prod cannot exhibit the same-tick race; the dedup behavior remains a sandbox-only property)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">32</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>Unsubscribe</code> removes the observer; subsequent state changes do NOT fire it</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code>, <code>playground:auth-listener-unsub</code> (bundled) + <code>playground:auth-row-32-unsubscribe-stops-fires</code> (one-claim) + oracle: <code>scripts/oracle/observations/auth-row-32-unsubscribe-stops-fires.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 fire on <code>signInAnonymously</code> → call <code>unsub()</code> → <code>signOut</code> + <code>signInAnonymously</code> + <code>signOut</code> produce zero further fires; <code>postUnsubFires: 0, unsubscribeStoppedFires: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">33</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Multiple subscribers all fire on each change</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-33-multiple-subscribers-all-fire.json</code> (against blockingfun, fb-js-sdk 12.13.0: two subscribers registered back-to-back each see 1 initial null fire, +1 on <code>signInAnonymously</code>, +1 on <code>signOut</code>; <code>bothFiredOnSignIn: true, bothFiredOnSignOut: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">33a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Registry is array-backed (matches upstream <code>util/subscribe.ts</code>): the SAME observer fn registered N times produces N independent registrations that each fire, and one <code>Unsubscribe</code> removes exactly one registration. A resubscribe of a previously-unsubscribed fn fires its initial value again. (Per-registration initial-fire bookkeeping, not a shared per-observer dedup.)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listener-registry.test.ts</code> (locks AUTH-B3 + AUTH-B4)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">34</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Unsubscribing during emission does not skip remaining subscribers (snapshotted iteration)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">35</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A throwing observer doesn't block other observers from firing</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-35-throwing-observer-doesnt-block-others.json</code> (<code>secondObserverContinuedFiring: true</code> against blockingfun, fb-js-sdk 12.13.0 — observer #1 throws on every call, observer #2 still counts the initial fire AND the post-sign-in fire)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">36</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Observer object form (<code>{next, error, complete}</code>) works alongside the function form</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-36-observer-object-form-works.json</code> (against blockingfun, fb-js-sdk 12.13.0: one observer as <code>NextFn</code>, another as <code>{next, error, complete}</code>. Both forms see 1 initial null fire, +1 on <code>signInAnonymously</code>, +1 on <code>signOut</code>; <code>bothFormsFiredOnSignIn: true, bothFormsFiredOnSignOut: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">37</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Setting the same user twice does NOT double-fire (structural-equality no-op). Sandbox-internal <code>setCurrentUser</code> claim; the prod analog is <code>signInAnonymously</code> called twice in a row (per fix #399, the second call returns the same user).</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-37-same-user-no-double-fire.json</code> (against blockingfun, fb-js-sdk 12.13.0: first <code>signInAnonymously</code> fires the listener once; second call returns the same uid (<code>sameUserAcrossCalls: true</code>) and does NOT produce a fresh fire (<code>secondSignInProducedFire: false</code>). Prod also recognizes the same-user no-op)</div></div>
</details>
</div>

## `onIdTokenChanged(auth, observer)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">38</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires on user change (sandbox shares the auth-state path)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-38-onidtokenchanged-fires-on-user-change.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribe → 1 initial fire (null) → <code>signInAnonymously</code> → +1 (user₁) → <code>signOut</code> → +1 (null) → <code>signInAnonymously</code> → +1 (user₂ with fresh uid). Every identity transition produces exactly one fire, matching <code>onAuthStateChanged</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">38a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires on EVERY sign-in, including a same-uid re-sign-in (no <code>signOut</code> first) — which mints a fresh token, so a subsequent <code>getIdToken()</code> returns a new string. Mirrors upstream <code>notifyAuthListeners</code>, which calls <code>idTokenSubscription.next</code> on every identity update (<code>auth_impl.ts:716</code>). <code>onAuthStateChanged</code> stays silent on the same-uid case (row 30a).</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-uid-dedup.test.ts</code> (locks AUTH-B8)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">39</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires on token refresh (<code>getIdToken(true)</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-token-refresh.test.ts</code> — was ⚠ (documented divergence); aligned to prod in commit on branch <code>claude/close-auth-token-refresh</code> — sandbox now mints a fresh token on forceRefresh and fires <code>onIdTokenChanged</code> (NOT <code>onAuthStateChanged</code>, since identity is unchanged). Oracle: <code>scripts/oracle/observations/auth-onidtokenchanged-force-refresh.json</code> defines the target shape (<code>refreshFiredListener: true</code> against blockingfun; subscribe → null fire → <code>signInAnonymously</code> → +1 → <code>getIdToken(true)</code> → +1 for a total of 3 fires).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">40</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Initial-fire semantics match <code>onAuthStateChanged</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code> + oracle: <code>scripts/oracle/observations/auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire.json</code> (against blockingfun, fb-js-sdk 12.13.0: subscribing both listeners in the same tick yields <code>sync: {auth: 0, idToken: 0}</code> → <code>microtask: {auth: 1, idToken: 1}</code> → no further fires. Both listeners share the microtask-deferred initial-fire timing)</div></div>
</details>
</div>

## `setPersistence(auth, persistence)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">41</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Accepts <code>inMemoryPersistence</code> / <code>browserSessionPersistence</code> / <code>browserLocalPersistence</code> markers without throwing</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:types.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">42</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>Promise&lt;void&gt;</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:types.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">43</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Actually changes where the auth state is persisted</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox is a no-op. Prod respects the marker.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">43a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">An unrecognized persistence marker (not one of the three) is rejected with <code>auth/argument-error</code> on the prod backend, rather than silently coerced to LOCAL</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-cluster-b9-b12.test.ts</code> (locks AUTH-B12)</div></div>
</details>
</div>

## `signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">44</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns the pre-staged <code>UserCredential</code> registered via <code>sandbox.mockSignInResult(auth, …)</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">45</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>auth/no-mock-configured</code> when no mock is pre-staged</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">46</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Mock is consumed after one read (subsequent call without a fresh stage throws again)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">47</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">After successful sign-in, <code>currentUser</code> becomes the mock's <code>user</code>, listeners fire</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">47a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The credential's rich <code>User</code> (email / displayName / isAnonymous) survives the transition — popup/redirect/credential/<code>setUser</code> do NOT clobber it down to the bare <code>AuthState</code>; <code>cred.user === auth.currentUser</code> (reference identity, matches upstream <code>_updateCurrentUser(userCredential.user)</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-identity.test.ts</code> (locks AUTH-B1)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">48</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Opens a popup window in prod</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox skips the popup; mock pre-stage replaces the popup result</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">49</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Cancels with <code>auth/popup-closed-by-user</code> when the user dismisses the popup (prod)</span></summary>
<div class="compat-evidence"><div class="compat-probe">not modeled — would require the host to expose a "cancel" affordance on the mock</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">70</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Provider-flow sign-ins (popup / redirect / credential) record the flow's <code>providerId</code> on the identity in the user DB (upsert for unknown uids; append-if-missing for known ones) and reject disabled accounts with <code>auth/user-disabled</code> before any state change</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("provider tracking", "disabled users") — provider recording is sandbox bookkeeping for <code>listIdentities</code>/<code>listUsers</code>; prod's auto-link semantics are narrower (same-email Google auto-link only) and not modeled</div></div>
</details>
</div>

## `signInWithRedirect` / `getRedirectResult` / resolver seam

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>signInWithRedirect(auth, provider, resolver?)</code> resolves the flow (per-call resolver → injected → one-shot mock → <code>auth/argument-error</code>), signs the user in, and stashes the credential for one <code>getRedirectResult</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getRedirectResult(auth)</code> returns the stashed credential once, then <code>null</code> (one-shot, matches prod)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49c</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.setAuthFlowResolver(auth, resolver | null)</code> installs / clears the popup/redirect resolver (the analog of browser <code>getAuth</code> wiring <code>browserPopupRedirectResolver</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49d</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.listIdentities(auth)</code> snapshots every seeded/created identity for a host account-picker (sandbox-only — no <code>firebase/auth</code> equivalent)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-resolver.test.ts</code></div></div>
</details>
</div>

## `Auth` surface + error shape

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49e</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>auth.signOut()</code> method form works alongside the free <code>signOut(auth)</code> function (<code>firebase/auth</code>'s <code>Auth</code> exposes both) (AUTH-GAP)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49f</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox auth errors are real <code>FirebaseError</code> instances (<code>err instanceof FirebaseError</code>) carrying the prod message wrapper <code>Firebase: &lt;message&gt; (&lt;auth/...&gt;).</code> — e.g. <code>Firebase: Error (auth/invalid-email).</code>, matching the oracle (AUTH-GAP)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
</div>

## Provider classes (`GoogleAuthProvider`, `EmailAuthProvider`, etc.)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">50</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Exports the same constructor signatures as <code>firebase/auth</code> for each provider</span></summary>
<div class="compat-evidence"><div class="compat-probe">type-only smoke in <code>unit:types.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">51</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Provider.credential(...)</code> static factories produce <code>AuthCredential</code>-shaped objects</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">52</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>GoogleAuthProvider.providerId === 'google.com'</code> (and per-provider analogs)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">53</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Custom scopes / params / language code</span></summary>
<div class="compat-evidence"><div class="compat-probe">sandbox ignores; prod forwards</div></div>
</details>
</div>

## `User` methods

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">54</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.getIdToken()</code> returns a stable opaque token in sandbox (<code>sandbox-id-token-…</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-anonymous.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">55</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.getIdToken(true)</code> (forceRefresh) returns a NEW token; subsequent <code>getIdToken(false)</code> returns the cached new token</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-token-refresh.test.ts</code> — was ⚠ (documented divergence); aligned to prod in commit on branch <code>claude/close-auth-token-refresh</code> — sandbox now mints a fresh token on forceRefresh and fires <code>onIdTokenChanged</code>. Oracle: <code>scripts/oracle/observations/auth-getidtoken-force-refresh.json</code> defines the target shape (<code>forceRefreshReturnedDifferentString: true</code>, <code>token1EqualsToken2: true</code> against blockingfun — the refreshed token is cached, so a subsequent non-forced read returns it, not yet another fresh one). Sandbox tokens stay <code>sandbox-id-token-&lt;uid&gt;-&lt;hash&gt;</code> strings; prod's are real JWTs.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">56</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.getIdTokenResult()</code> returns claims</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code> (custom-claims path)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">57</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.uid</code>, <code>user.email</code>, <code>user.displayName</code>, <code>user.isAnonymous</code> reflect the source</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-anonymous</code>, <code>playground:auth-email-password</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">58</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.emailVerified</code> — present on every sandbox-minted <code>User</code> (default <code>false</code>; sandbox has no verification flow). Prod passes the real value through (no longer stripped). The admin record (<code>sandbox.listUsers</code>) carries it too</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code> (locks AUTH-GAP)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">58a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.photoURL</code> / <code>user.phoneNumber</code> — present (sandbox default <code>null</code>; prod passes through, no longer stripped)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">58b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>user.providerId</code> (aggregate, <code>'firebase'</code>) + <code>user.providerData: UserInfo[]</code> — sandbox synthesizes one provider entry for non-anonymous users, empty for anonymous; prod passes the real array through (no longer stripped). The admin record carries the emulator-shaped <code>providerUserInfo</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:auth-gap-surface.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">59</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>user.metadata.creationTime</code> / <code>lastSignInTime</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">client <code>User.metadata</code> not exposed (AUTH-GAP); the admin record carries <code>createdAt</code>/<code>lastLoginAt</code> (ISO)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">68</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>IdTokenResult.signInProvider</code> reflects the session's provider per flow (<code>'anonymous'</code> / <code>'password'</code> / <code>'google.com'</code> / …); claims include the reserved <code>firebase.sign_in_provider</code> (custom claims can't shadow it)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("IdTokenResult.signInProvider") — prod shape is documented SDK behavior; no oracle capture yet</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">75</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Custom-claims changes (<code>sandbox.updateUser</code> / re-seed) reach an active session on the next FORCED token refresh, not immediately — claims are read live from the user DB at mint time (prod's refresh-propagation story; AUTH-B10)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code>, <code>unit:sandbox-cluster-b9-b12.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">61</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>user.reload()</code> / <code>user.delete()</code> / <code>user.toJSON()</code> / <code>user.refreshToken</code> / <code>user.tenantId</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">not modeled by the sandbox; documented in the deny-list rather than synthesized (AUTH-GAP)</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">62</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>updateProfile(user, {displayName, photoURL})</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented</div></div>
</details>
</div>

## `sandbox.*` (sandbox-only test driver)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">63</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.seedUsers(auth, [{uid, email, password, displayName?, customClaims?, providerId?}])</code> seeds the user DB; <code>providerId</code> defaults to <code>'password'</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-test-driver.test.ts</code>, <code>unit:sandbox-user-admin.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">63a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Re-seeding an existing uid OVERWRITES it: a new email drops the stale email→record mapping (the old email no longer signs in), and re-seeded <code>customClaims</code> are LIVE — a held <code>User</code>'s <code>getIdToken(true)</code> reflects the new claims rather than the claims frozen at mint time</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-cluster-b9-b12.test.ts</code> (locks AUTH-B9 + AUTH-B10)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">64</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.setUser(auth, user)</code> / <code>sandbox.setUser(auth, null)</code> directly switches identity. Bypasses the <code>disabled</code> check and does NOT bump <code>lastLoginAt</code> (not a real sign-in)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-test-driver.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">65</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.mockSignInResult(auth, {providerId, user, …})</code> pre-stages a popup/credential result</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-providers.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">66</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">All <code>sandbox.*</code> methods throw <code>failed-precondition</code> on prod-backed handles</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-test-driver.test.ts</code>, <code>unit:sandbox-user-admin.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">67</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.reset()</code> (host-side, via <code>Sandbox.reset()</code>) clears auth state and fires sign-out</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-listeners.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">71</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.listIdentities(auth)</code> returns the REAL provider per identity — <code>providerId</code> primary label (<code>'anonymous'</code> for anonymous users) + emulator-shaped <code>providerUserInfo</code> array; anonymous users included</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("provider tracking") — fixes the pre-epic mislabeling (<code>'password'</code>/<code>'anonymous'</code> only)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">72</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.createSignInCredential(auth, {providerId, uid | spec})</code> mints backend-owned credentials for host-driven flows: <code>{uid}</code> picks an existing identity (<code>auth/user-not-found</code> for unknown uids); <code>{spec}</code> upserts (same-email reuse; default uid <code>'&lt;providerId&gt;:&lt;email&gt;'</code>; no password). Tokens route through the backend token cache</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("sandbox.createSignInCredential")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">73</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">User-admin CRUD: <code>sandbox.listUsers</code> / <code>createUser</code> (no sign-in; <code>auth/uid-already-exists</code>, <code>auth/email-already-in-use</code>, <code>auth/invalid-email</code>, <code>auth/weak-password</code>) / <code>updateUser</code> (displayName incl. null-clear, email re-key, password + provider link, customClaims wholesale replace, disabled, emailVerified) / <code>deleteUser</code> / <code>clearUsers</code>. Deletion/clear/disable do NOT terminate active sessions (prod parity). Record shape: <code>{uid, email, displayName, phoneNumber, photoUrl, customClaims, providerUserInfo, isAnonymous, disabled, emailVerified, createdAt, lastLoginAt}</code> with ISO timestamps</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> (CRUD describes)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">74</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.subscribeUsers(auth, cb)</code> fires a coarse no-payload callback on every user-DB mutation (seed/create/update/delete/clear, provider links, lastLoginAt bumps); no initial fire; throwing listeners isolated; unsubscribe stops fires</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-user-admin.test.ts</code> ("sandbox.subscribeUsers")</div></div>
</details>
</div>

## `beforeAuthStateChanged(auth, callback, onAbort?)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">76</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Registers a BLOCKING gate that runs before a real sign-in/sign-out transition commits. Callbacks run in registration order; a callback that throws (or returns a rejected promise) aborts the transition entirely: the pending <code>signInWith…</code>/<code>signOut</code> call rejects with <code>auth/login-blocked</code>, <code>currentUser</code> is unchanged, and <code>onAuthStateChanged</code>/<code>onIdTokenChanged</code> do NOT fire. Covers every sign-in path that exists in <code>pyric/auth</code>: <code>signInAnonymously</code>, <code>signInWithEmailAndPassword</code>, <code>createUserWithEmailAndPassword</code>, <code>signInWithPopup</code>, <code>signInWithRedirect</code>, <code>signInWithCredential</code>, and <code>signOut</code> (pyric has no <code>signInWithCustomToken</code> yet). Modeled after the real <code>@firebase/auth</code> <code>AuthMiddlewareQueue.runMiddleware</code> (<code>auth_impl.ts</code>), read directly from the installed SDK source, not just its <code>.d.ts</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> — implementation cross-checked against <code>@firebase/auth</code>'s <code>AuthMiddlewareQueue</code> source (registration-order queue, per-callback try/await, <code>auth/login-blocked</code> wrap). No live-oracle capture (no observable client-visible signal to probe beyond the documented+sourced contract already read).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">76a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>onAbort</code> semantics: when a callback throws, every <code>onAbort</code> registered by a callback that ALREADY SUCCEEDED in the same pass runs, in REVERSE registration order — matches upstream's rollback-stack (<code>runMiddleware</code>'s <code>onAbortStack</code>). An <code>onAbort</code> that itself throws is swallowed so it can't mask the original block reason or skip the remaining rollbacks.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> ("onAbort runs (in reverse order)…", "a callback whose own onAbort throws…")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">76b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fires on BOTH directions: a real sign-in (<code>nextUser</code> non-null) and a real sign-out (<code>nextUser === null</code>) — a throwing callback blocks <code>signOut</code> too, leaving the previous user signed in. Matches upstream, where the same middleware queue gates <code>_updateCurrentUser</code> and <code>signOut</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> ("fires on sign-out too…")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">76c</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>sandbox.setUser</code> (the sandbox-only test driver) BYPASSES the gate entirely — it is a raw identity force with no prod analog (same bypass it already has for provider enforcement / <code>signInProvider</code> tracking), so no registered <code>beforeAuthStateChanged</code> callback runs and none can block it.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-before-auth-state-changed.test.ts</code> ("sandbox.setUser test driver bypasses the gate")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">76d</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Served-worker path (SharedWorker-backed auth, <code>pyric-tools</code>'s <code>serve/entries/auth.ts</code>): the worker owns the shared user pool and commits transitions on its own side of the port, so a page-local <code>beforeAuthStateChanged</code> registration can't actually gate a worker-driven sign-in. Rather than silently accept a callback that would never run, registering THROWS immediately (<code>auth/operation-not-supported-in-this-environment</code>) — same defensive pattern as <code>signInWithCredential</code> over the worker.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>packages/pyric-tools/src/serve/worker/client.ts</code> (<code>beforeAuthStateChanged</code> throws <code>makeUnsupported</code>)</div></div>
</details>
</div>

## Deny-list (intentionally NOT shimmed)

These exist in `firebase/auth` but the sandbox refuses to import/use
them. The agent's writeApp prompt and the deploy bundle's metafile
gate enforce the deny-list at build time.

| Name | Reason |
|---|---|
| `linkWithCredential` / `linkWithPopup` / `linkWithRedirect` | v0 scope — account linking is non-trivial state |
| `unlink` | Same as above |
| `reauthenticateWithCredential` / `reauthenticateWithPopup` / `reauthenticateWithRedirect` | v0 scope |
| `updateEmail` / `updatePassword` | Mutates auth state in ways the sandbox doesn't model |
| `verifyBeforeUpdateEmail` / `sendEmailVerification` / `applyActionCode` / `checkActionCode` / `confirmPasswordReset` / `sendPasswordResetEmail` / `verifyPasswordResetCode` | Email-link flows require an SMTP path; deliberately out of scope |
| `multiFactor(user)` / MFA APIs | Not modeled |
| `useDeviceLanguage` / `setLanguageCode` | i18n surface; not in v0 |
| `User.reload()` / `User.delete()` / `User.toJSON()` | Account-lifecycle / serialization the sandbox doesn't model — documented (not synthesized) per AUTH-GAP; the cheap profile fields (`photoURL`/`emailVerified`/`phoneNumber`/`providerData`/`providerId`) ARE present |
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
