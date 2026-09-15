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
   terminated by permission denial must be explicitly attached again.
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
