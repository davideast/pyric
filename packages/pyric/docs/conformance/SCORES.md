<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# Conformance

<div class="compat-scoreboard">
<a class="compat-score-row" href="../pyric-firestore-compat/">
<span class="compat-score-name">Firestore</span>
<span class="compat-score-pct">88%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 146"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 20"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-auth-compat/">
<span class="compat-score-name">Auth</span>
<span class="compat-score-pct">83%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 84"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 11"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 5"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-database-compat/">
<span class="compat-score-name">Realtime Database</span>
<span class="compat-score-pct">87%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 224"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 10"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 13"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 11"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-storage-compat/">
<span class="compat-score-name">Storage</span>
<span class="compat-score-pct">83%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 85"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 6"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 11"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-messaging-compat/">
<span class="compat-score-name">Messaging</span>
<span class="compat-score-pct">100%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 56"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-rules-compat/">
<span class="compat-score-name">Rules</span>
<span class="compat-score-pct">79%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 27"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 7"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-ai-compat/">
<span class="compat-score-name">AI Logic</span>
<span class="compat-score-pct">93%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 74"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 6"></span>
</div>
</a>
<a class="compat-score-row" href="../pyric-app-compat/">
<span class="compat-score-name">App</span>
<span class="compat-score-pct">93%</span>
<div class="compat-stat-bar compat-stat-bar--mini">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 14"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 1"></span>
</div>
</a>
</div>

Auth, Firestore, and Rules are held to recorded production behavior. Realtime Database and Storage are earlier and pinned to fewer production observations.

## How the numbers are made

The mirror is one to one. The call you write against Firebase is the call Pyric runs, character for character.

```ts
import { signInWithEmailAndPassword } from 'firebase/auth'; // production
import { signInWithEmailAndPassword } from 'pyric/auth';    // development
```

So "does Pyric match?" becomes one question per behavior: did Pyric answer what production answered?

A probe runs the call against a real Firebase project and records what came back.

```json
{ "name": "auth-wrong-password-error-code", "rowIds": ["auth#15"], "fbSdkVersion": "12.13.0", "behavior": { "code": "auth/wrong-password", "messageContains": { "wrongPassword": true, "invalidCredential": false } } }
```

Each recording is committed and replayed on every change by `compat:check`, and a build fails if the sandbox answers differently. Re-capturing a recording is the drift check. An unchanged file means production still behaves as pinned. A changed file means the behavior moved, and the git diff is the report.

Put the claim under load yourself: run the app, break a rule, and compare the verdict against production in <a href="../ship-to-production/">ship to production</a>.
