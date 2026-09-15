# Section 2: run the manual checkpoint

Run these commands from this worktree using Node 22.15+ and Bun. They create a
disposable project on port **48765** and leave the existing demo on 43110 alone.
The supplied page has buttons and visible results; no browser-console code is needed.

## 1. Build and start hosted mode

In terminal A, from the repository root:

```sh
repo_dir="$PWD"
bunx tsc --project packages/pyric/tsconfig.json &&
  bunx tsc --project packages/cli/tsconfig.json
qa_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-two.XXXXXX")"
cp -R "$repo_dir/packages/cli/test/manual/section-two/." "$qa_dir/"
printf '%s\n' "$qa_dir"
cd "$qa_dir"
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --hosted --ui --bridge --no-open --no-cache --no-capture \
  --seed seed.json --port 48765
```

Keep this terminal open and save the printed temporary path. Wait for
`Local server: http://localhost:48765`. If that port is occupied, stop here and
choose another unused port consistently in the commands and URLs below.
Warnings about missing hosting configuration or unused RTDB/Storage rules are
expected: this fixture exercises Auth and Firestore only.

Open **http://localhost:48765/** in two independent browsers, such as Chrome and
the Codex in-app browser. Call them **A** and **B**. Both must display `Runtime: hosted`.
On a fresh copy both start signed out. For a repeated run, click **Sign out** first.

The fixture seeds these local test accounts and Rules automatically:

| Account | UID | Tenant | Initial role | Password |
| --- | --- | --- | --- | --- |
| blue@example.test | blue-user | blue | editor | password |
| red@example.test | red-user | red | viewer | password |

Reads require matching UID and tenant; writes additionally require `role: editor`.
The buttons supply these credentials. Nothing connects to a Firebase project.

## 2. Check identity, Rules and refreshed claims

1. In A click **Sign in blue editor**. Expect UID `blue-user`, configured/user/token
   tenants all `blue`, role `editor`.
2. In B click **Sign in red viewer**. Expect UID `red-user`, all tenants `red`, role
   `viewer`. A must still show its blue identity.
3. In A click **Write blue document**: expect `Written: blue write …`. Then click
   **Write red document**: expect `permission-denied`.
4. In B click **Write red document**, then **Write blue document**: both must report
   `permission-denied`. Expected Rules denials also increment the Pyric chip's
   failed-request counter; they are part of this check.
5. In A select `red` in **Next sign-in tenant**, then click **Refresh token**.
   Only `configuredTenant` may become `red`. UID, user tenant and token tenant
   must remain `blue-user`, `blue`, `blue`; **Write blue document** must still work.
6. In terminal B, from the repository root, promote only the red account:

   ```sh
   node packages/cli/test/manual/section-two/set-claims.mjs http://localhost:48765/ editor
   ```

7. In B click **Refresh token**. Expect `role: editor`, with UID and tenants still
   red. **Write red document** must now succeed; **Write blue document** must still
   be denied. A must retain its blue identity and editor access.
8. In both browsers click **Listen to my document**. Each shows its latest document
   and starts at one listener update. Click each browser's own write button once;
   its listener must show that new message and increase its count by exactly one.

Wait for each button's result before clicking the next button.

## 3. Restart without reloading either browser

In terminal A press **Ctrl+C** and wait for shutdown. In the same terminal,
which is still in the temporary project directory, run:

```sh
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --hosted --ui --bridge --no-open --no-cache --no-capture --port 48765
```

Keep both browser pages open. Do not reload or sign in again. After the server is
ready, allow up to ten seconds for recovery, then:

1. Click **Refresh token** in both browsers. A must still be `blue-user` with user
   and token tenant `blue`, even though its configured tenant is `red`. B must
   remain `red-user`, tenant `red`, role `editor`.
2. Note each listener count. Click the browser's own write button once. Expect a
   successful write, the new document message, and exactly one additional update.
   Recovery and token refresh may deliver current snapshots; count from after
   both have settled.
3. Check the cross-tenant write buttons are still denied.
4. In B click **Sign out**. Its identity becomes null. In A refresh and write blue
   again: its blue identity and access must remain intact.
5. In B click **Sign in blue editor**, then **Sign out**, then **Sign in red viewer**.
   Verify its UID/tenant follows each sign-in. The red button uses the red account;
   after promotion its displayed role remains `editor` despite the button label.
   A must remain blue throughout.

To repeat with the original red role, run this in terminal B and refresh B's token:

```sh
node packages/cli/test/manual/section-two/set-claims.mjs http://localhost:48765/ viewer
```

## 4. Check actual host expiry and a delayed browser notification

Use this deterministic command from the repository root. It launches its own
short-lived project; leave the manual host and browsers running:

```sh
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  session-expiry.pw.ts --grep 'delayed browser' --reporter=list
```

Expect **1 passed**, normally in about 68 seconds. The test pauses browser timers,
withholds a committed increment's acknowledgement, closes the host connection,
waits 62 real seconds for host retention to expire, then delivers the delayed
browser close. It checks the original UID, one listener, successful new writes,
and exactly one increment in storage and on the wire. This is controlled fault
injection, not evidence that the physical computer slept. An ordinary server
restart cannot replace this check because it also changes the host's identity.

## 5. Repeat isolation in SharedWorker and in-page modes

Keep terminal A running. In terminal C, from the repository root, make a fresh copy
so hosted state and the promoted account do not affect this check:

```sh
repo_dir="$PWD"
worker_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-two-worker.XXXXXX")"
cp -R "$repo_dir/packages/cli/test/manual/section-two/." "$worker_dir/"
cd "$worker_dir"
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --ui --bridge --no-open --no-cache --no-capture --seed seed.json --port 48766
```

Open **http://localhost:48766/** in **two tabs of the same browser**, so they share
one native worker. Both must display `shared-worker`. Repeat steps 2.1–2.5, then
sign out in B and verify A still writes blue. Sign B in blue, then red again;
A must remain blue. Close both tabs after checking.

For the fallback, use terminal D from the repository root:

```sh
repo_dir="$PWD"
inpage_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-two-inpage.XXXXXX")"
cp -R "$repo_dir/packages/cli/test/manual/section-two/." "$inpage_dir/"
cd "$inpage_dir"
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --ui --bridge --no-open --no-cache --no-capture --seed seed.json --port 48767
```

Open **http://localhost:48767/?runtime=inpage** in two tabs of the same browser.
This fixture sets the fallback test override before SDK imports. Both must display
`in-page`. Repeat the same identity/denial/sign-out checks. Wait a second after each
identity change to allow account broadcasts; the other tab must keep its own UID,
tenant and role. Close these two tabs after checking.

## 6. Stop and record the outcome

Press **Ctrl+C** in terminals C and D. Keep A running if you want to inspect the
hosted result, or stop it with Ctrl+C too. Temporary project directories contain
only this fixture and its local state and can be discarded when finished.

Record which browsers ran, each displayed runtime, which numbered steps passed,
and any unexpected result. Distinguish the interactive browser checks from the
controlled expiry test. Section 3 is the next implementation section.

## Recorded run — 2026-09-15

Executed against `86cdc3da` with the fixture alongside this procedure:

| Check | Execution | Result |
| --- | --- | --- |
| Build and hosted startup | Node 22.18.0; both TypeScript builds; disposable project on 48765 | Passed |
| Identity, Rules and claims (section 2) | Chrome and Codex in-app browser; both displayed `hosted` | Passed |
| Restart and session isolation (section 3) | Same port, persisted state, both pages left open; own writes delivered one additional listener update each | Passed |
| Restore original red role | Control command followed by Chrome token refresh displayed `viewer` | Passed |
| Delayed host expiry (section 4) | Exact command above; real retention wait | 1 passed in 1.1 minutes |
| SharedWorker isolation (section 5) | Two Codex in-app tabs; both displayed `shared-worker` | Passed |
| In-page isolation (section 5) | Two Codex in-app tabs; both displayed `in-page` | Passed |
| Cleanup | Worker and in-page tabs closed; their servers stopped | Passed |

The hosted checkpoint was left running at **http://localhost:48765/**. The
existing demo on 43110 was untouched. Expected Rules denials appeared in the
page and Pyric error counter. No unexpected checkpoint failure occurred.

These are interactive UI checks plus one automated fault-injection check.
Physical laptop sleep and independent browser-engine coverage were not tested.
