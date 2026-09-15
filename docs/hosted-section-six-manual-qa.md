# Section 6 manual checkpoint: compatibility and diagnostics

Use disposable projects. Leave the phase 4/Tailscale demos on their existing
ports. These checks require the built CLI and embedded Studio from this branch.

## Build and install the candidate

From the repository root:

```sh
bash scripts/build.sh
bash scripts/pack-packages.sh --skip-build
repo_dir="$PWD"
consumer_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-phase-six.XXXXXXXX")"
printf '{"private":true,"type":"module"}\n' > "$consumer_dir/package.json"
cd "$consumer_dir"
npm install --no-audit --no-fund \
  "$repo_dir/dist/packages/pyric-0.1.0-alpha.22.tgz" \
  "$repo_dir/dist/packages/pyric-admin-0.1.0-alpha.22.tgz" \
  "$repo_dir/dist/packages/pyric-cli-0.1.0-alpha.20.tgz" \
  "$repo_dir/dist/packages/create-pyric-0.1.0-alpha.22.tgz" vite@5.4.21
mkdir checkpoint
cp "$repo_dir"/packages/cli/test/manual/section-four/* checkpoint/
cd checkpoint
node ../node_modules/@pyric/cli/dist/cli/index.js sandbox \
  --hosted --ui --bridge --no-open --no-capture --no-cache --port 48771
```

For this completed run, the installation location is recorded in
`ignored/section6/consumer-dir.txt`. Reuse it to avoid rebuilding. Package labels
alone do not identify this unpublished candidate: retain its tarball hashes and
package lock. No npm publication is part of this procedure.

## Shared data and connection recovery

1. Open `http://localhost:48771/` and
   `http://localhost:48771/__pyric/ui/firestore` in separate tabs.
2. Leave Studio open, then click **Write document** in the app. It should say
   **Written**. Studio should show **shared → greeting**, containing that same
   write. A startup snapshot alone is insufficient: write again while Studio
   stays open and check the changed value.
3. In the app, open **pyric → Sandbox**. Its hosted row says **Connected**.
4. Press Ctrl-C in the host terminal. The app says **Reconnecting**, disables
   writes, and the chip says **Reconnecting**. Studio reports
   **Hosted connection lost; reconnecting.**
5. Repeat the server command in the same directory and port. Both pages recover
   without reload. The app can write again and Studio sees the update. Studio's
   current connection error disappears. Previously recorded errors can remain
   in Traffic history; they do not mean the current connection is still down.

Hosted Studio must also work in a browser without SharedWorker. The default
SharedWorker path remains available when starting without `--hosted`.

## Persistence failure and repair

Keep the server running. In a second terminal, substitute the checkpoint path
created above:

```sh
cd /absolute/path/to/consumer/checkpoint
chmod 500 .pyric/state
```

1. Click **Write document**. Expect `committed-but-not-durable`: the change is in
   memory, but it was not saved. Do not repeat the operation as a retry.
2. The next explicit write must report `persistence-unhealthy` and must not
   execute. Read-only inspection remains available. The app's Traffic tab
   records the persistence error.
3. To exercise Studio's own error surface, open **Storage**, click **Upload
   files**, and select a small disposable text file. The first failing mutation
   reports committed-but-not-durable if the host was healthy immediately before
   this upload; otherwise it correctly reports persistence-unhealthy. Studio's
   status explains the persistence failure without displaying file contents.
4. Repair permissions:

   ```sh
   chmod 700 .pyric/state
   ```

   Permission repair alone does not reopen mutation admission. Stop and restart
   the host, then verify a new write succeeds. Inspect recovered state before
   deciding what to do about a previously uncertain operation.

## Restoration refusal and private-data checks

Stop the disposable host before editing its state:

```sh
cp .pyric/state/state.json .pyric/state/state.json.checkpoint-backup
printf 'secret42 private42' > .pyric/state/state.json
node ../node_modules/@pyric/cli/dist/cli/index.js sandbox \
  --hosted --bridge --no-open --no-capture --port 48771
```

Startup must refuse before readiness, identify invalid JSON and its location,
and leave the file intact. Neither marker may appear in the diagnostic. Restore
the disposable backup and start again:

```sh
mv .pyric/state/state.json.checkpoint-backup .pyric/state/state.json
node ../node_modules/@pyric/cli/dist/cli/index.js sandbox \
  --hosted --ui --bridge --no-open --no-capture --port 48771
```

The default startup snippet omits the beacon token. Its connection settings still
work for separately started commands; automatic interception confirmation requires
launching the command through Pyric, which supplies the token privately.
Explicit document/file inspection and exports intentionally contain data and are
not redacted diagnostic output.

## Repeatable artifact and fault checks

From the repository root, use the retained installed consumers:

```sh
export PYRIC_PACKED_CONSUMER="$(cat ignored/section6/consumer-dir.txt)"
export PYRIC_PUBLISHED_CONSUMER="$(cat ignored/section6/legacy-consumer.txt)"
node node_modules/@playwright/test/cli.js test \
  -c packages/cli/test/e2e/hosted/playwright.section-six.config.ts
node node_modules/@playwright/test/cli.js test \
  -c packages/cli/test/e2e/hosted/playwright.config.ts \
  section-six-restoration section-six-diagnostics section-six-studio
```

The compatibility cases load the real candidate and published alpha.19 remote
packages. Both must complete Auth, write/listener and explicit close/reconnect
operations against the candidate host. The actual alpha.19 host uses `pyric dev`;
the candidate browser must refuse it before any write and explain the required
upgrade. It must retain hosted selection rather than opening a local fallback.
This is a tested artifact subset, not a blanket alpha-version compatibility range.

## Executed in-app checkpoint — 2026-09-15

The native in-app browser showed **Phase 6 in-app verified write** arriving in
Studio's already-open `shared/greeting` document after an app button click.
The app chip displayed **Hosted Connected**, then **Hosted Reconnecting** when
the disposable host stopped. Studio showed **Hosted connection lost;
reconnecting.** Restart recovered both pages and a new write succeeded.
The final stop removed Studio's stale connected-count and MCP badges.
The two checkpoint tabs were closed and port 48771 was stopped.

Automated minimum-Node checks additionally exercised malformed-file restoration,
unwritable-state refusal and repair, Studio's committed Storage upload, and
SharedWorker-absent Studio. Those fault injections are automated evidence, not
claimed manual file-upload or phone verification.

## Repeated full checkpoint — 2026-09-15, commit `93a45e6d`

Reused the retained installed candidate and created a fresh `checkpoint-rerun`
project on port 48771. This run used the in-app browser for every interactive
step, including the Storage file chooser. No rebuild or package publication.

| Check | Observed result |
| --- | --- |
| Live shared data | Two distinct button writes appeared in the already-open Studio document without reload. |
| Disconnect | The app disabled writes and showed Reconnecting; its chip showed Hosted Reconnecting. Studio removed connected badges and reported the lost connection. |
| Restart | Both pages recovered without reload; another write reached Studio. |
| First persistence failure | `committed-but-not-durable`; the in-memory document and listener changed. |
| Subsequent write | `persistence-unhealthy`; the document and listener count remained unchanged. Both errors appeared in Traffic. |
| Studio upload | Selecting the disposable marker file through Upload files produced the expected persistence-unhealthy error. Neither private marker appeared in its diagnostic. |
| Permission repair and restart | The last durable document returned, replacing the unpersisted value. Studio's current error cleared and a new app write succeeded. Historical Traffic and upload errors remained. |
| Corrupt JSON | Startup exited with code 2, named the invalid state file, omitted both markers, and preserved the corrupt bytes. Restoring the backup recovered the open app. |
| Startup snippet | External-command settings were present; the beacon token was absent. |

The two repeatable commands also passed on Node 22.18.0: **3 compatibility cases
in 6.4 seconds**, and **8 fault/Studio cases in 29.1 seconds**. The latter includes
SharedWorker-absent Studio and a Storage upload that commits before persistence
fails; those two cases remain automated evidence. Logs are retained locally in
`ignored/section6/manual-rerun-packed.log` and
`ignored/section6/manual-rerun-faults.log`.

All expected checks passed. Temporary tabs 21–22 were closed, port 48771 was
stopped, and disposable state permissions and contents were restored. Existing
demo tabs, servers, and Tailscale routes were left untouched. No phone check was
performed in this run.
