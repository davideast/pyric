# Section 5 checkpoint: Rules reload and event retention

Use Node 22.15.0 or newer. These commands run disposable projects and leave the
existing demos, including the Tailscale host on 48769, untouched.

## Build and run the focused checks

From the repository root:

```bash
bun run --cwd packages/pyric build
bun run --cwd packages/cli build
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts section-five
```

The browser checks cover a paused real WebSocket reader, continued healthy SDK
writes, history eviction, continued live delivery, capture refusal in `pyric
verify`, and actual Rules file edits in hosted, SharedWorker and in-page modes.
They report the stalled-reader latency and RSS measurements. A disconnected
reader receives close code 1013; a later event subscriber receives an explicit
history gap. The test owns and closes only its temporary servers and tabs.

## Prepare an interactive Rules checkpoint

From the repository root, in a new terminal:

```bash
repo_dir="$PWD"
checkpoint_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-five.XXXXXXXX")"
cp "$repo_dir"/packages/cli/test/manual/section-five/* "$checkpoint_dir/"
cat > "$checkpoint_dir/firestore.rules" <<'RULES'
service cloud.firestore {
  match /databases/{db}/documents {
    match /checks/{id} { allow read, write: if request.auth != null; }
  }
}
RULES
cat > "$checkpoint_dir/database.rules.json" <<'RULES'
{"rules":{"checks":{".read":"auth != null",".write":"auth != null"}}}
RULES
printf 'Checkpoint directory: %s\n' "$checkpoint_dir"
cd "$checkpoint_dir"
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox \
  --hosted --bridge --no-open --no-capture --port 48770
```

1. Open <http://localhost:48770/?app=red&service=firestore> and
   <http://localhost:48770/?app=blue&service=firestore> in two tabs. Both must say
   `hosted`, `Ready`, and show different users. Click **Write document** and
   **Read document** in each; expect `Succeeded` and listener deliveries.
2. Copy the red tab's user ID. In another terminal, set `checkpoint_dir` to the
   directory printed above and `red_uid` to that ID, then run:

   ```bash
   red_uid='PASTE_RED_USER_ID'
   cat > "$checkpoint_dir/firestore.rules" <<RULES
   service cloud.firestore {
     match /databases/{db}/documents {
       match /checks/{id} { allow read, write: if request.auth.uid == '$red_uid'; }
     }
   }
   RULES
   ```

   Expect a successful reload in the server terminal. Blue's listener must
   report `permission-denied`; its reads and writes must fail. Red must still
   read and write successfully, and each red write adds one red delivery.
3. Write invalid source:

   ```bash
   printf 'not valid rules {\n' > "$checkpoint_dir/firestore.rules"
   ```

   The terminal must report `NOT reloaded (last-good stays live)`. Repeat the
   checks: red succeeds; blue remains denied.
4. Restore the original Firestore rules from the setup command. Blue's reads
   and writes must succeed again. Click **Start listener** in blue: a listener
   terminated by permission denial must be explicitly attached again. In-page
   Firestore can resume automatically when repaired Rules allow it; clicking
   **Start listener** still replaces that listener and must not duplicate delivery.
5. Repeat using `service=database` in both URLs. Copy the new red UID and restrict
   the actual RTDB file with:

   ```bash
   red_uid='PASTE_RED_DATABASE_USER_ID'
   cat > "$checkpoint_dir/database.rules.json" <<RULES
   {"rules":{"checks":{".read":"auth.uid == '$red_uid'",".write":"auth.uid == '$red_uid'"}}}
   RULES
   ```

   Blue loses access; red retains it. Write `not valid rules {` to this file,
   verify the rejected reload and retained permissions, then restore its
   original setup contents and explicitly restart blue's listener.
6. Stop only this server with Ctrl+C. Repeat without `--hosted` and expect
   `shared-worker`. For genuine in-page fallback, use a browser without
   SharedWorker support. The automated suite also forces that selection and
   asserts the actual runtime before each check.

Storage Rules file watching is outside the existing CLI watcher contract.
These checks cover Firestore and RTDB; they do not change direct SDK invalid-Rules
semantics. Event history retains at most 10,000 observations plus a gap record,
within 8 MiB. Worker capture hydration retains its existing 2,000-event tail,
now with an explicit gap. A truncated capture cannot be replayed or verified as
complete; start a fresh capture session for verification. Direct SDK full history
and Firestore undo history retain their existing contracts.

## Executed checkpoint — 2026-09-15

Executed against commit `f7a4860d` using Node 22.18.0, including fresh Pyric/CLI builds and all
12 focused scenarios (passed in 2.1 minutes, no skips or retries).

The actual in-app browser walkthrough completed 96 button actions across
Firestore and RTDB in hosted, default SharedWorker and in-page modes:

| Check | Observed result in all six combinations |
| --- | --- |
| Initial access | Red and blue had distinct users; both reads and writes succeeded. |
| Red-only Rules | Blue reads/writes were denied and its listener stopped delivering; red continued, with one delivery per write. |
| Invalid file edit | Terminal reported `NOT reloaded (last-good stays live)`; the same permissions remained enforced. |
| Repaired Rules | Blue reads/writes succeeded; explicit listener replacement restored delivery without duplication. |

Hosted and SharedWorker Firestore, and RTDB in all three modes, retained a
permission error until **Start listener** was clicked. In-page Firestore resumed
its listener automatically after repair, before that click. The steps above now
state this distinction. Expected denial codes were `permission-denied` for
Firestore and `PERMISSION_DENIED` for RTDB; deliberate denials also appeared in
the runtime error counter.

For the interactive fallback check, the disposable page temporarily made
`SharedWorker` unavailable before its module script ran. Both pages visibly
reported `in-page`; this was the current in-app browser with simulated API
absence, not a claim of testing an older browser engine. The temporary override
was removed afterward.

The slow-reader run stayed within its declared budgets: healthy-write p95 was
95.8 / 74.1 ms and RSS growth was 127,074,304 / 178,618,368 bytes across two
cycles. Both slow readers closed with code 1013. Count/byte history eviction,
subsequent live delivery and incomplete-capture refusal all passed.

Logs and the disposable project path are retained under
`ignored/section5/manual-run/`. The checkpoint server on 48770 and the two test
tabs were closed after verification. Existing demos and Tailscale routes were
not changed. No product code changed during this walkthrough.
