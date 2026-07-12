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

> These scores measure how much of each surface Pyric's conformance system has verified against recorded production behavior. They are a measure of that system, not a guarantee that Pyric matches production in every case, and not a substitute for testing your own changes before you ship.

## How does pyric know it works like Firebase?

If Pyric is a mirror of Firebase, how does it know it actually behaves like Firebase? You can read the documentation and you can mirror the TypeScript API, but documentation describes intent and types describe shape. Neither is production behavior. The only source of truth for what Firebase does is Firebase itself, so the only honest way to mirror it is to capture that behavior and hold yourself to it. That is what it means to conform.

It starts one to one. The call you write against Firebase is the call Pyric runs, character for character.

```ts
import { signInWithEmailAndPassword } from 'firebase/auth'; // production
import { signInWithEmailAndPassword } from 'pyric/auth';    // development
```

## The conformance system

Pyric ships an entire conformance system, [`pyric/conformance`](https://github.com/davideast/pyric/tree/main/packages/conformance). It probes a real production Firebase project, captures what it observes, and treats those captures together with Firebase's official TypeScript exports as the specification it must conform to. A handful of parts do the work, and the life of a single behavior runs through all of them.

<div class="conformance-flow">
<div class="flow-step">Production Firebase</div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Capture<span class="flow-sub">oracle + corpus</span></div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Registry<span class="flow-sub">the spec</span></div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">compat:check<span class="flow-sub">replay</span></div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Conformance matrices</div>
</div>

### The oracle

The oracle is where production behavior enters the system. A [probe](https://github.com/davideast/pyric/tree/main/packages/conformance/probes) signs into a real Firebase project, makes a real call, and records exactly what comes back: the value, the error code, the shape of the response, down to the SDK version that produced it. That recording is committed to the repository as an observation, so it is not a claim about Firebase, it is a captured fact from Firebase, frozen in a file anyone can open:

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

This one file, [`auth-wrong-password-error-code.json`](https://github.com/davideast/pyric/blob/main/packages/conformance/observations/auth/auth-wrong-password-error-code.json), pins what a wrong password throws. It names the rows it is responsible for, so that captured fact becomes the sole authority for row `auth#15` on the Auth matrix. Every verified behavior has an observation like it, and they all live in the open under [observations/](https://github.com/davideast/pyric/tree/main/packages/conformance/observations).

### The corpus

Security Rules cannot be captured by recording a call, because a ruleset is a program and the question is not what it returns but whether it allows or denies a request. So the oracle for rules is a corpus: a growing body of rulesets paired with requests, each one evaluated against Google's own Rules Test API to get production's verdict. The sandbox rule simulator then has to reach the same allow or deny for every case in the [corpus](https://github.com/davideast/pyric/tree/main/packages/conformance/rules-corpus). Firestore and Storage expose a hosted Test API to ask directly; Realtime Database exposes none, so its rules are captured the hard way, by deploying each ruleset to a throwaway database, observing the live verdict, and restoring the database afterward.

```rules
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    // reading a missing field is a runtime error, so this DENIES
    match /typoEqNullDeny/{id} {
      allow create: if request.resource.data.typo == null;   // expect: DENY
    }
    // the correct absence check uses `in`, so this ALLOWS
    match /notInAllow/{id} {
      allow create: if !('typo' in request.resource.data);   // expect: ALLOW
    }
  }
}
```

Production's Rules Test API returns DENY and ALLOW for these, and the sandbox simulator must return the same, or the case fails.

### The registry

Captures on their own are just files. The registry is what turns them into a specification. It is the row universe: one numbered entry per behavior, each carrying the capture that pins it, the status it currently holds, and the reason for that status. The [registry](https://github.com/davideast/pyric/tree/main/packages/conformance/registry) is the contract these matrices render. A conforming row points at a passing replay; a documented difference states both what production does and what Pyric does and why; a not-yet-verified row is one the system knows about but no capture has pinned. Nothing lands on the board by accident, and nothing that matters is quietly left off it.

```ts
{
  rowRef: '15',
  api: 'signInWithEmailAndPassword(auth, email, password)',
  behavior: 'A wrong password throws auth/wrong-password',
  status: 'conforms',
  evidence: 'oracle:auth-wrong-password-error-code',
}
```

The `evidence` points at the observation from the oracle section, and the `status` is what the matrix renders.

### The replay

A specification is only worth its enforcement. On every change, `compat:check` replays every committed capture against the sandbox and compares verdict for verdict. If the sandbox answers differently than the recording, the build fails before the change can land, so a regression cannot merge without either fixing the code or consciously re-pinning the row in the open. Re-capturing an observation is the same check pointed the other way: run the [probes](https://github.com/davideast/pyric/blob/main/packages/conformance/src/run.ts) again, and an unchanged file means production still behaves as recorded, while a changed file means Firebase itself moved, and the git diff is the incident report.

```console
$ bun run compat:check
auth#15  signInWithEmailAndPassword
  recorded: auth/wrong-password
  sandbox:  auth/invalid-credential
  FAIL: sandbox disagrees with the recording
```

A red build like this cannot merge until the code is fixed or the row is re-pinned in the open.

### The census

Captures answer whether Pyric behaves like Firebase, but there is a second question hiding behind the first: does Pyric even expose what Firebase exposes? A perfect match on ten behaviors means little if Firebase ships a hundred. The [census](https://github.com/davideast/pyric/blob/main/packages/conformance/src/surface-census.ts) answers it by reading Firebase's official TypeScript exports for each module and checking, symbol by symbol, that Pyric mirrors them. This is the second specification the system holds itself to: the oracle pins behavior, and the census pins surface against the real public API, so coverage is measured against what Firebase actually ships rather than a list Pyric drew up for itself.

```console
$ bun run compat:census  (pyric/auth vs firebase/auth)
  mapped:   getAuth, signInWithEmailAndPassword, onAuthStateChanged, ...
  unmapped: multiFactor, RecaptchaVerifier   (upstream, not yet mirrored)
  extra:    withAuth                           (pyric-only helper)
```

Unmapped symbols are the exact gap the surface number measures, counted against Firebase's real exports.

### What this does not prove

This is the honest part. Conformance measured this way is a floor, not a guarantee of total equivalence.

- **It covers only what has been recorded.** A behavior with no observation is marked not yet verified, never assumed to match. Those rows are shown on the matrices, not hidden.
- **Recordings are snapshots.** Each pins one SDK version against one project's configuration. A behavior that depends on config the oracle project does not have goes uncaught until it is recorded. `fetchSignInMethodsForEmail` is a real case: the oracle project had the password provider disabled, so the capture proved nothing, and the call is left unimplemented on the strength of the SDK's own type declaration instead.
- **The row universe is not all of Firebase.** These matrices track the behaviors someone thought to probe. Firebase surface that no one has exercised is not on the board, and absence from the board is not a pass.
- **The proof is uneven.** Auth, Firestore, and Rules are pinned deeply. Realtime Database and Storage are earlier, with fewer recordings, and Realtime Database rules are the thinnest of all. The scores above say where the ground is solid and where it is still early, on purpose.

### How scores are calculated

Every percentage on these pages, the figure at the top of each matrix and each bar on the scoreboard, is the same calculation: the share of a surface's evaluated behaviors that conform.

```
score = conforming rows / evaluated rows
```

An evaluated row is any behavior the registry tracks with a recorded status: conforming, a documented difference, not supported yet, or not verified yet. Only conforming rows count toward the score. The other three sit in the denominator but not the numerator, which is why the four buckets under each figure always add back up to the total. The denominator is the tracked row universe, not all of Firebase, so a rising score means more of what has been probed conforms, not that more of Firebase has been covered.

No number here is typed by hand. Each row's status is read from the ledger (`baselines/coverage-baseline.json`) at generate time, and `compat:check` re-reads the same ledger, so a page whose figure drifts from the data fails the build before it can merge.

### Verify against production before you ship

Pyric works hard to mirror production behavior, but a mirror is still a mirror, and comprehensive production fidelity is not something any local tool can promise. That is what verification and testing are for, and it is why Pyric hands you the tools to check its work against the real thing rather than asking you to take the scores on faith.

`pyric verify` replays a recorded session of your app against a candidate ruleset and reports which verdicts would change, so a regression is caught before it reaches users. And because the same code runs against real Firebase in production, shipping is itself the final check: run the app, break a rule, and compare the verdict against production in <a href="../ship-to-production/">ship to production</a>.

> Use Pyric for local development, where it is fast and has no production consequences. Then test the impact of your changes in a staging or production environment before you ship them, the way you would with any backend. The scores on this page measure how well Pyric's conformance system has done its job; they do not, and cannot, stand in for that final test against production itself.
