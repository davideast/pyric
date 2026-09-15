# Section 3: run the manual checkpoint

Use Node 22.15+ and Bun. Run from this worktree's repository root. This creates a
disposable project on **48768**, leaving the earlier demos on 43110 and 48765 alone.

## Start the checkpoint

```sh
repo_dir="$PWD"
bunx tsc --project packages/pyric/tsconfig.json &&
  bunx tsc --project packages/cli/tsconfig.json
qa_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-three.XXXXXX")"
cp -R "$repo_dir/packages/cli/test/manual/section-three/." "$qa_dir/"
printf '%s\n' "$qa_dir"
cd "$qa_dir"
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --hosted --ui --bridge --no-open --no-cache --no-capture --port 48768
```

Wait for `Local server: http://localhost:48768`. Keep the terminal running. If the
port is already occupied, choose a different unused port throughout this procedure.
Each page creates two named Firebase apps with independent anonymous identities
and connections. Their data is shared within the selected runtime. No production
Firebase project is used.

## Disconnect actions

Open **http://localhost:48768/**. Expect runtime `hosted`, result `Ready`, and both
connections `true`. Wait for each button's result before continuing.

1. Click **Arm disconnect**. The observer displays
   `{"state":"online","untouched":"initial","executions":0}`.
2. Click **Cancel untouched child**, then **Owner offline**. Owner connectivity
   becomes `false`; observer stays `true`. Expect
   `{"state":"offline","untouched":"initial","executions":1}`.
   Only the cancelled child is preserved, and the remaining work executes once.
3. Click **Owner online**, then **Observer writes returned**. Expect owner
   connectivity `true` and state `returned`, with `executions: 1`.
4. Click **Delete owner**. Expect result `Done`; the observer's data stays
   `returned` with `executions: 1`. Consumed disconnect work must not run again.
5. Reload the page to create a new owner. Click **Arm disconnect**, then
   **Cancel disconnect**, then **Owner offline**. The data must stay `online`,
   `untouched: initial`, `executions: 0`, despite the owner's disconnected state.
6. Click **Owner online**, then **Arm disconnect**, then **Delete owner**.
   Fresh disconnect work must run: state `offline`, `untouched: disconnected`,
   `executions: 1`. The observer remains connected.

The execution counter makes duplicate effects visible. Socket loss also consumes
accepted disconnect work immediately; retaining Auth for recovery does not defer
that work. Apps must register new disconnect intent after reconnecting.

## Concurrent and rejected writes

Open **http://localhost:48768/concurrent.html**. Each contention button resets its
own counter, so it can be repeated.

1. Click **Run Firestore contention**. Expect
   `{"firstReads":[0,1],"final":2}`. Client one pauses after reading zero; client
   two commits one; client one retries against one and commits two.
2. Click **Run RTDB contention**. Expect both `committed` values to be `true` and
   `final: 2`. The displayed callback histories can vary with scheduling. In-page
   execution can serialize the callbacks without retrying.
3. Click **Reject Firestore batch**. Expect error `permission-denied`,
   `allowed: {"value":"before"}`, and `blockedExists: false`.
4. Click **Reject RTDB update**. Expect error `PERMISSION_DENIED` and
   `stored: {"allowed":"before"}`. Neither rejected operation may partially
   update its allowed target. The Pyric chip counts these intentional denials.

## Repeat runtime parity

Close both checkpoint pages. Press **Ctrl+C** in the checkpoint terminal, then
restart from the same temporary directory without `--hosted`:

```sh
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --ui --bridge --no-open --no-cache --no-capture --port 48768
```

Open the same two URLs and verify they display `shared-worker`. Repeat the
numbered disconnect and concurrent-write steps, then close both pages.

For genuine in-page fallback, open these URLs:

- **http://localhost:48768/?runtime=inpage**
- **http://localhost:48768/concurrent.html?runtime=inpage**

Both must display `in-page`. Repeat the same steps. The override is set before
SDK imports; these are in-page checks, not silently repeated SharedWorker checks.

## Controlled transport failures

These commands run automated fault injection in separate disposable projects.
Run from the repository root in another terminal:

```sh
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  section-three-expiry.pw.ts section-three-lost-ack.pw.ts \
  rtdb-socket-loss.pw.ts lost-ack.pw.ts --reporter=list
```

Expect four passing cases. The expiry case waits 62 real seconds while browser
timers are paused. It checks immediate disconnect execution, no repeated effect
at expiry, a fresh host grant, recovered connectivity, and fresh disconnect work
on deletion. This does not simulate physical laptop sleep.

The lost-acknowledgment cases withhold a committed write's reply. The SDK reports
uncertainty, recovery preserves the committed value, and transport never repeats
the mutation. The RTDB case also counts transmitted increments and verifies a
new explicit increment succeeds after recovery.

For the fast three-runtime checks without the real retention wait:

```sh
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  section-three-disconnect.pw.ts section-three-concurrent.pw.ts \
  section-three-lost-ack.pw.ts --reporter=list
```

Expect 13 passing cases. Close the checkpoint pages and stop the server with
**Ctrl+C** when finished. Record displayed runtimes, results and any unexpected
behavior; distinguish UI verification from automated fault injection.

## Recorded checkpoint — 2026-09-15

The hosted numbered disconnect and concurrent-write steps passed interactively
in the Codex in-app browser. The two pages displayed `hosted`; the owner alone went
offline, disconnect effects executed once, both transaction updates committed,
and denied writes preserved data. The host remains on port 48768 with a fresh
owner ready for another run.

SharedWorker and in-page steps passed in the automated three-runtime SDK suite.
The fast command passed 13 cases in 26.1 seconds. The four controlled transport
cases passed within the affected integration run; actual expiry used the real
62-second wait. No physical sleep or independent browser-engine pass is claimed.
