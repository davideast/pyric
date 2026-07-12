---
title: "Conformance"
navLabel: "Conformance scores"
group: "Conformance"
section: ""
order: 7001
---
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

## How does pyric know it works like Firebase?

"Behaves like Firebase" is a claim anyone can print. Pyric earns it by making the claim falsifiable: every green row on these pages traces to a recording of real production, and a test that fails the build the moment the recording and the sandbox disagree.

The mirror starts one to one. The call you write against Firebase is the call Pyric runs, character for character.

```ts
import { signInWithEmailAndPassword } from 'firebase/auth'; // production
import { signInWithEmailAndPassword } from 'pyric/auth';    // development
```

So "does Pyric match?" reduces to one question asked once per behavior: did Pyric answer what production answered? To answer it, a probe runs the real call against a real Firebase project and records exactly what came back. That recording is an oracle observation, committed to the repository:

```json
{
  "name": "auth-wrong-password-error-code",
  "rowIds": ["auth#15"],
  "fbSdkVersion": "12.13.0",
  "behavior": {
    "code": "auth/wrong-password",
    "messageContains": { "wrongPassword": true, "invalidCredential": false }
  }
}
```

That one file ([auth-wrong-password-error-code.json](https://github.com/davideast/pyric/blob/main/packages/conformance/observations/auth/auth-wrong-password-error-code.json)) pins what a wrong password throws, and it locks row `auth#15` on the Auth matrix. Every verified behavior has its own, under [observations/](https://github.com/davideast/pyric/tree/main/packages/conformance/observations). The [registry](https://github.com/davideast/pyric/tree/main/packages/conformance/registry) maps each recording to a numbered row, and `compat:check` replays every recording against the sandbox on each change. If the sandbox answers differently than production did, the build fails before the change lands. Recapturing a recording is the drift check: an unchanged file means production still behaves as pinned; a changed file means the behavior moved, and the git diff is the report.

Security Rules work the same way from the other direction. A [corpus](https://github.com/davideast/pyric/tree/main/packages/conformance/rules-corpus) of rulesets and requests is evaluated against Google's own Rules Test API, and the sandbox simulator has to reach the same verdict, case for case. The [probes](https://github.com/davideast/pyric/tree/main/packages/conformance/probes) that capture production and the [runner](https://github.com/davideast/pyric/blob/main/packages/conformance/src/run.ts) that replays it are all in the open.

### What this does not prove

This is the honest part. Conformance measured this way is a floor, not a guarantee of total equivalence.

- **It covers only what has been recorded.** A behavior with no observation is marked not yet verified, never assumed to match. Those rows are shown on the matrices, not hidden.
- **Recordings are snapshots.** Each pins one SDK version against one project's configuration. A behavior that depends on config the oracle project does not have goes uncaught until it is recorded. `fetchSignInMethodsForEmail` is a real case: the oracle project had the password provider disabled, so the capture proved nothing, and the call is left unimplemented on the strength of the SDK's own type declaration instead.
- **The row universe is not all of Firebase.** These matrices track the behaviors someone thought to probe. Firebase surface that no one has exercised is not on the board, and absence from the board is not a pass.
- **The proof is uneven.** Auth, Firestore, and Rules are pinned deeply. Realtime Database and Storage are earlier, with fewer recordings, and Realtime Database rules are the thinnest of all. The scores above say where the ground is solid and where it is still early, on purpose.

Put the claim under load yourself: run the app, break a rule, and compare the verdict against production in <a href="../ship-to-production/">ship to production</a>.
