# Empirical oracle harness

Locks ambiguous matrix rows by running probes against bare upstream
`firebase/auth` + `firebase/firestore` (no `@pyric/*` shim) against a
**real Firebase project**. Each observation captures what production
Firebase actually does so the matrix can cite "observed empirically
against firebase-js-sdk &lt;version&gt; on &lt;date&gt;" rather than guessing.

Methodology background: the design rationale.

## Why real cloud — not the emulator

The Firestore emulator has known divergences from cloud Firestore,
and the gap widens over time as cloud services evolve. For an oracle
that needs to be the source of truth, only the real service counts.
We use the upstream Web SDK against a dedicated Firebase project.

## One-time project setup

You need a dedicated Firebase project for oracle observations.
Putting these in a production project would pollute real data with
test users and test docs.

1. **Create the project.** In the Firebase console, create a new
   project named e.g. `pyric-oracle`. Stay on the free tier — the
   harness's traffic is negligible.

2. **Enable Anonymous sign-in.** Authentication → Sign-in method →
   Anonymous → Enable.

3. **Add a Web App** to the project. Project Settings → General →
   Your apps → `&lt;/&gt;` Web. Copy the config object — the JSON-shaped
   one with `apiKey`, `authDomain`, `projectId`, etc.

4. **Set Firestore rules scoped to the oracle namespace.** The
   harness writes every doc under the top-level `pyric_oracle`
   collection. Paste the following into Firestore → Rules:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
      match /pyric_oracle/{run}/{doc=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

   This restricts the oracle's access to its own namespace, so the
   harness can't accidentally touch anything else if you ever reuse
   the project.

## Running the harness

```sh
export PYRIC_ORACLE_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"…","projectId":"…","storageBucket":"…","appId":"…"}'
bun run scripts/oracle/run.ts
```

Each probe writes its observation to
`scripts/oracle/observations/&lt;name&gt;.json`. Commit those JSON files
alongside the matrix — they're the locked oracle. Re-running the
harness updates them in place; the diff tells you whether cloud
behavior has shifted since the last observation.

The whole suite finishes in well under a minute (probes are tiny —
a handful of `setDoc`/`getDoc`/`deleteDoc` calls each).

## What the harness cleans up

- **Docs.** Each probe writes under
  `pyric_oracle/&lt;timestamp&gt;-&lt;random&gt;/&lt;probe&gt;` and deletes everything
  in that run namespace on the way out. A failed probe still gets a
  best-effort purge.
- **Anonymous users.** Every probe that signs in deletes the
  anonymous user before returning, with one exception: the
  `auth-signout-idempotent` probe deliberately ends signed out, so
  the anonymous user it minted can't be deleted from the client
  SDK afterwards. **This leaks one anonymous user per run of that
  probe.** Anonymous users are free up to 50k MAU; periodically
  purge them from the console (Authentication → Users → filter to
  anonymous → delete) or via the Admin SDK if scale becomes an
  issue. Not in this harness's scope.

## Adding a probe

In `run.ts`, append to the `probes` array:

```ts
{
  name: 'firestore-some-behavior',   // file name + log label
  matrixRow: 'firestore #N',         // the row this locks
  description: 'one-line plain English',
  async observe() {
    await signInAnonymously(auth);
    // ... do the work, return a plain JSON-serializable object ...
    await dropCurrentUser();
    return { threw: false, fooBar: 'baz' };
  },
},
```

Write to `${RUN_ID}-&lt;probe-tag&gt;` for any docs you create — the
harness purges that namespace between probes so a failure can't
poison the next one. Return value becomes the `behavior` field of
the observation; keep it small and explicit.

## Current coverage and gates

The committed oracle now contains 127 observations across Auth,
Firestore, RTDB, RTDB modular, and Storage. The compatibility ledger is
derived from the four `COMPAT.md` matrices and the structured overlay in
`scripts/compat/registry.json`.

Useful commands:

```sh
bun run compat:report           # coverage inventory; debt is reported, not failed
bun run compat:validate         # registry/observation linkage validation
bun run compat:audit            # high-risk ✓ rows lacking evidence
bun run compat:oracle-versions  # every observation matches bun.lock's firebase version
bun run compat:oracle-check     # run registry-linked conformance probes
```

`compat:oracle-check` is a derived gate: it does not carry a hand-written
status field. Each registry entry names an observation and a local probe.
If the probe passes, Pyric conforms to the pinned production behavior; if
it fails, the gate classifies the result as either infrastructure/setup or
a live behavior contradiction.

## Realtime Database probes

RTDB probes follow the same pattern but require **one additional
piece of project setup**: the oracle project must have an RTDB
instance with rules that permit anonymous writes under
`/pyric_oracle/*`.

- **Provision the instance.** Firebase Console → Realtime Database
  → Create Database. Pick any region; the harness discovers the
  instance URL via the Firebase Database Management API
  (`projects/<projectId>/locations/-/instances`).
- **Loosen the rules.** Paste this snippet into Realtime Database →
  Rules:

  ```json
  {
    "rules": {
      ".read": false,
      ".write": false,
      "pyric_oracle": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
  ```

- If the project has **no** RTDB instance, the harness silently
  skips RTDB probes (each one records `{ "skipped": true,
  "reason": "no rtdb instance on project" }` and the runner moves
  on). Firestore + Auth probes still run.
- If the project has an instance but the rules don't permit
  `/pyric_oracle/*`, the probes still record observations — they
  just capture the rules-rejection error shape instead of the
  happy-path behavior. The `rtdb-rules-denied-error-code` probe
  uses this on purpose to lock the upstream SDK's error shape.

RTDB observations now cover REST shape, rules deployment/denial, set/get,
server timestamps, listener basics, push keys, shallow reads, simulator
agreement, and the modular SDK surface. Run `bun run compat:report` for
the current row/observation counts instead of maintaining a prose list by
hand.
